import { test } from 'bun:test';
import { recoveryScenario } from '../support/recovery-scenario';

const recovery = process.env.RECOVERY === '1' ? test : test.skip;
recovery(
  'mixed-channel multiprocess failures recover every wallet and event',
  recoveryScenario,
  120000,
);
