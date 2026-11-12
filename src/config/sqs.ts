import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';

export function createSqsClient(config: AppConfig) {
  return new SQSClient({
    region: config.awsRegion,
    endpoint: config.sqsEndpoint,
    credentials: config.awsAccessKeyId && config.awsSecretAccessKey
      ? { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey } : undefined,
  });
}
