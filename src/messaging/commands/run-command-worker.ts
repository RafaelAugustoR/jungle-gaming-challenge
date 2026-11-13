import type { AppConfig } from '../../config/config';
import { WageringRepository } from '../../modules/wagering/infrastructure/persistence/wagering-repository';
import { createSubmission } from '../../modules/wagering/infrastructure/create-submission';
import { runWorker } from '../worker-runtime';
import { dlqName, queueUrl } from '../queue';
import {
  CommandConsumer,
  type CommandConsumerObserver,
  type CommandConsumerOptions,
} from './command-consumer';
import type { loadCommandConfig } from './config';
type Options = ReturnType<typeof loadCommandConfig> &
  Partial<Pick<CommandConsumerOptions, 'queueUrl' | 'dlqUrl'>>;
export async function runCommandWorker(
  config: AppConfig,
  options: Options,
  hooks: {
    observer?: CommandConsumerObserver;
    onReady?: () => void;
    once?: boolean;
    pollMs?: number;
  } = {},
) {
  try {
    await runWorker(
      'command',
      async ({ orm, sqs, signal }) => {
        const resolveOptions = { signal, timeoutMs: options.callTimeoutMs };
        const source = options.queueUrl ?? (await queueUrl(sqs, options.queueName, resolveOptions));
        const dlq =
          options.dlqUrl ?? (await queueUrl(sqs, dlqName(options.queueName), resolveOptions));
        return new CommandConsumer(
          createSubmission(new WageringRepository(orm, config), config),
          sqs,
          {
            ...options,
            queueUrl: source,
            dlqUrl: dlq,
            financialDeadlineMs: config.financialDeadlineMs,
          },
          hooks.observer,
        );
      },
      { config, once: hooks.once ?? false, pollMs: hooks.pollMs ?? 0, onReady: hooks.onReady },
    );
  } finally {
    if (process.connected) process.disconnect?.();
  }
}
