import { SQSClient } from '@aws-sdk/client-sqs';

export function createSqsClient() {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 2000 },
  });
}
