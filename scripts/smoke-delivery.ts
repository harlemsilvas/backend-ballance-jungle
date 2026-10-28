import { randomUUID } from 'node:crypto';
import { SendMessageCommand,ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { localSqsClient,localQueueUrl } from '../src/infrastructure/messaging/local-sqs';

// Creates synthetic financial data. Run only against the selected local demo stack.
const base=process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3000';
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('LOCAL_SMOKE_REQUIRED');
async function request(path: string,body?: unknown,key?: string) {
  const response=await fetch(base+path,{ method: body ? 'POST':'GET',headers: {
    'Content-Type':'application/json',...(key ? {'Idempotency-Key':key}:{}),
  },...(body ? {body:JSON.stringify(body)}:{}) });
  if (!response.ok) throw new Error(`SMOKE_HTTP_${response.status}`);
  return response.json() as Promise<Record<string,any>>;
}
function check(ok: boolean) { if (!ok) throw new Error('SMOKE_ASSERTION_FAILED'); }
async function main() {
  await request('/health/ready');
  const wallet=await request('/wallets',{playerId:randomUUID(),initialBalance:{amount:'100.00',currency:'BRL'}});
  const bet={providerId:'delivery-smoke',externalTransactionId:randomUUID(),playerId:wallet.playerId,walletId:wallet.id,
    roundId:randomUUID(),gameId:'smoke',kind:'BET',money:{amount:'25.00',currency:'BRL'}};
  const key=randomUUID();
  const first=await request('/wagering/transactions',bet,key);
  const replay=await request('/wagering/transactions',bet,key);
  check(first.status==='PROCESSED' && replay.idempotentReplay===true && replay.balance.amount==='75.00');
  const win={...bet,externalTransactionId:randomUUID(),kind:'WIN',money:{amount:'10.00',currency:'BRL'}};
  const client=localSqsClient();
  try {
    const queueUrl=await localQueueUrl(client,'wager-transactions.fifo');
    await client.send(new SendMessageCommand({QueueUrl:queueUrl,MessageGroupId:wallet.id,MessageDeduplicationId:randomUUID(),
      MessageBody:JSON.stringify({messageId:randomUUID(),type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{idempotencyKey:randomUUID(),...win}})}));
    console.log(JSON.stringify({event:'DeliveryCommandsSubmitted',walletId:wallet.id}));
    let done=false;
    for (let attempt=0;attempt<100;attempt++) {
      const current=await request(`/wallets/${wallet.id}`);
      if(current.balance.amount==='85.00') {done=true;break;}
      await Bun.sleep(200);
    }
    check(done);
    const events=await localQueueUrl(client,'wager-events.fifo');
    let published=false;
    for (let attempt=0;attempt<20;attempt++) {
      const batch=await client.send(new ReceiveMessageCommand({QueueUrl:events,WaitTimeSeconds:1,MaxNumberOfMessages:10}));
      if (batch.Messages?.some(message => JSON.parse(message.Body ?? '{}').aggregateId===wallet.id)) {published=true;break;}
    }
    check(published);
    check((await request(`/wallets/${wallet.id}/reconciliation`,{})).consistent===true);
    const metrics=await fetch(base+'/metrics');check(metrics.ok && (await metrics.text()).includes('wager_'));
    console.log(JSON.stringify({event:'DeliverySmokePassed',walletId:wallet.id}));
  } finally {client.destroy();}
}
void main().catch(() => {console.error('Delivery smoke failed');process.exitCode=1;});
