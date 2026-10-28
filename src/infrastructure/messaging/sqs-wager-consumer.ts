import { NOOP_TELEMETRY,type Telemetry,type LogFields } from '../../application/telemetry';
import { createHash } from 'node:crypto';
import { SQSClient,ReceiveMessageCommand,DeleteMessageCommand,ChangeMessageVisibilityCommand,SendMessageCommand,type Message } from '@aws-sdk/client-sqs';
import { prepareSqsWagerRequest } from '../../application/wager-request';
import type { ProcessWagerTransaction } from '../../application/financial-use-cases';
import { DomainError } from '../../domain/domain-error';

type Outcome = 'empty' | 'acked' | 'retry' | 'dlq';
interface Delivery { receipt: string; released: boolean; heartbeatStopped?: boolean; renewal?: Promise<unknown>; work?: Promise<Outcome> }
const permanent = new Set(['INVALID_PAYLOAD','INVALID_PROVIDER','UNSUPPORTED_CURRENCY','OPENING_IS_INTERNAL','INVALID_TRANSACTION_KIND',
  'INVALID_TRANSACTION_AMOUNT','REFERENCE_REQUIRED','REFERENCE_NOT_ALLOWED','INVALID_REFERENCE','INVALID_TIMESTAMP',
  'IDEMPOTENCY_CONFLICT','EXTERNAL_TRANSACTION_CONFLICT','WALLET_NOT_FOUND','INBOX_PAYLOAD_CONFLICT']);
function permanentError(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof DomainError && permanent.has(error.code))
    || (error instanceof Error && ['INVALID_MONEY_AMOUNT','INVALID_CURRENCY','MONEY_OUT_OF_RANGE'].includes(error.message));
}
export class SqsWagerConsumer {
  private stopping = false; private active: Delivery | undefined;
  constructor(private readonly client: SQSClient,private readonly process: ProcessWagerTransaction,
    private readonly options: { queueUrl: string; dlqUrl: string; consumerName?: string; visibilitySeconds?: number;
      maxReceives?: number; telemetry?: Telemetry; afterCommit?: () => Promise<void> }) {
    const visibility=options.visibilitySeconds ?? 30; const max=options.maxReceives ?? 5;
    if (!Number.isInteger(visibility) || visibility<1 || visibility>43200 || !Number.isInteger(max) || max<1
      || !(options.consumerName ?? 'wager-v1').trim()) throw new Error('INVALID_CONSUMER_OPTIONS');
  }
  private get telemetry(): Telemetry { return this.options.telemetry ?? NOOP_TELEMETRY; }
  async pollOnce(): Promise<Outcome> {
    if (this.stopping) return 'empty';
    if (this.active) throw new Error('CONSUMER_ALREADY_PROCESSING');
    const response = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.options.queueUrl,MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,VisibilityTimeout: this.options.visibilitySeconds ?? 30,
      MessageSystemAttributeNames: ['ApproximateReceiveCount','MessageGroupId'] }));
    const message = response.Messages?.[0];
    if (!message?.ReceiptHandle) return 'empty';
    const delivery: Delivery = { receipt: message.ReceiptHandle,released: false }; this.active = delivery;
    try {
      if (this.stopping) { await this.release(delivery); return 'retry'; }
      const work = this.handle(message,delivery); delivery.work = work; return await work;
    } finally { this.active = undefined; }
  }
  private async release(delivery: Delivery): Promise<void> {
    delivery.released = true; delivery.heartbeatStopped = true;
    await delivery.renewal?.catch(() => {});
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl,ReceiptHandle: delivery.receipt,VisibilityTimeout: 0 }));
  }
  private async handle(message: Message,delivery: Delivery): Promise<Outcome> {
    const visibility = this.options.visibilitySeconds ?? 30;
    const heartbeat = setInterval(() => {
      if (!delivery.released && !delivery.heartbeatStopped && !delivery.renewal) delivery.renewal = this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl,
        ReceiptHandle: delivery.receipt,VisibilityTimeout: visibility })).catch(() => { /* Redelivery remains safe via inbox. */ }).finally(() => { delete delivery.renewal; });
    },Math.max(100,Math.floor(visibility*1000/3)));
    heartbeat.unref();
    let fields: LogFields={ component: 'consumer',messageId: message.MessageId };
    try {
      try {
        const envelope = prepareSqsWagerRequest(JSON.parse(message.Body ?? ''));
        fields={ ...fields,messageId: envelope.messageId,correlationId: envelope.messageId,walletId: envelope.command.payload.walletId,providerId: envelope.command.payload.providerId };
        const result=await this.process.execute(envelope.command.payload,envelope.command.idempotencyKey,
          { correlationId: envelope.messageId,causationId: envelope.messageId },{
            consumerName: this.options.consumerName ?? 'wager-v1',messageId: envelope.messageId,payloadHash: envelope.transportHash,
          });
        fields.transactionId=result.transactionId; fields.status=result.status;
      } catch (error) {
        if (delivery.released) return 'retry';
        delivery.heartbeatStopped = true;
        await delivery.renewal?.catch(() => {});
        const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
        if (permanentError(error) || attempts >= (this.options.maxReceives ?? 5)) {
          const fifo = new URL(this.options.dlqUrl).pathname.endsWith('.fifo');
          const identity = createHash('sha256').update((message.MessageId ?? '') + ':' + (message.Body ?? '')).digest('hex');
          const failureCode = error instanceof DomainError ? error.code : error instanceof SyntaxError ? 'INVALID_JSON'
            : error instanceof Error && ['INVALID_MONEY_AMOUNT','INVALID_CURRENCY','MONEY_OUT_OF_RANGE'].includes(error.message) ? error.message : 'PROCESSING_FAILURE';
          await this.client.send(new SendMessageCommand({ QueueUrl: this.options.dlqUrl,MessageBody: message.Body ?? '',
            MessageAttributes: {
              failureCode: { DataType: 'String',StringValue: failureCode },
              failureClass: { DataType: 'String',StringValue: permanentError(error) ? 'PERMANENT' : 'RETRIES_EXHAUSTED' },
              sourceMessageId: { DataType: 'String',StringValue: message.MessageId ?? 'unknown' },
            },
            ...(fifo ? { MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',MessageDeduplicationId: identity } : {}) }));
          this.telemetry.count('wager_dlq_messages_total',{ reason: permanentError(error)?'permanent':'exhausted' });
          this.telemetry.event('message_forwarded_dlq',{ ...fields,code: failureCode,level: 'warn' });
          if (!delivery.released) await this.client.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl,ReceiptHandle: delivery.receipt }));
          return 'dlq';
        }
        await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl,ReceiptHandle: delivery.receipt,
          VisibilityTimeout: Math.min(300,2 ** Math.min(attempts-1,8)) }));
        this.telemetry.count('wager_retries_total',{ component: 'consumer' });
        this.telemetry.event('message_retry',{ ...fields,attempt: attempts,code: 'PROCESSING_RETRY',level: 'warn' });
        return 'retry';
      }
      // Observability/fault-injection boundary: commit completed; no ack has occurred yet.
      await this.options.afterCommit?.();
      if (delivery.released) return 'retry';
      await this.client.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl,ReceiptHandle: delivery.receipt }));
      this.telemetry.event('message_acked',fields);
      return 'acked';
    } finally { clearInterval(heartbeat); }
  }
  async run(): Promise<void> {
    while (!this.stopping) {
      try { await this.pollOnce(); }
      catch { if (!this.stopping) { this.telemetry.event('consumer_poll_failed',{ level: 'error',code: 'CONSUMER_RETRY',component: 'consumer' }); await new Promise(resolve => setTimeout(resolve,100)); } }
    }
  }
  async stop(graceMs = 5000): Promise<void> {
    this.stopping = true; const active = this.active;
    if (!active?.work) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([active.work.then(() => true,() => true),new Promise<false>(resolve => { timer=setTimeout(() => resolve(false),graceMs); })]);
      if (!finished) await this.release(active);
    } finally { if (timer) clearTimeout(timer); }
  }
}
