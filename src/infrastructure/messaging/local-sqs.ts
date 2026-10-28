import { SQSClient,GetQueueUrlCommand } from '@aws-sdk/client-sqs';
export function localSqsClient(endpoint = process.env.SQS_ENDPOINT ?? process.env.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:4567') {
  if (!['127.0.0.1','localhost','[::1]','localstack'].includes(new URL(endpoint).hostname)) throw new Error('LOCAL_SQS_ENDPOINT_REQUIRED');
  return new SQSClient({ endpoint,region: 'us-east-1',credentials: { accessKeyId: 'test',secretAccessKey: 'test' },
    maxAttempts: 1,requestHandler: { connectionTimeout: 2000,requestTimeout: 5000 } });
}
export async function localQueueUrl(client: SQSClient,name: string,endpoint = process.env.SQS_ENDPOINT ?? process.env.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:4567') {
  const response = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!response.QueueUrl) throw new Error('QUEUE_URL_MISSING');
  const url = new URL(response.QueueUrl); const host = new URL(endpoint); url.host = host.host; url.protocol = host.protocol;
  return url.toString();
}
