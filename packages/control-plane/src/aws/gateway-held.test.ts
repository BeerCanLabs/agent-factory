import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentContainerSecrets, secretName } from './gateway-held.js';

describe('S1 gateway-held secrets never reach an agent container', () => {
  const env = { FACTORY_GATEWAY_HELD_SECRETS: 'ANTHROPIC_API_KEY, OPENAI_API_KEY,NOTION_API_KEY' };

  it('drops gateway-held secrets by name, path, or ARN and keeps the rest', () => {
    const declared = [
      'NOTION_API_KEY',
      'factory/prod/NOTION_API_KEY',
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:factory/prod/NOTION_API_KEY-AbC123',
      'ANTHROPIC_API_KEY',
      'ARCHIE_DISCORD_BOT_TOKEN',
    ];
    assert.deepEqual(agentContainerSecrets(declared, env), ['ARCHIE_DISCORD_BOT_TOKEN']);
  });

  it('does not treat a longer name as the held one', () => {
    assert.deepEqual(agentContainerSecrets(['NOTION_API_KEY_OLD', 'MY_NOTION_API_KEY'], env), ['NOTION_API_KEY_OLD', 'MY_NOTION_API_KEY']);
  });

  it('keeps everything when nothing is gateway-held', () => {
    assert.deepEqual(agentContainerSecrets(['NOTION_API_KEY'], {}), ['NOTION_API_KEY']);
  });

  it('parses secret names', () => {
    assert.equal(secretName('arn:aws:secretsmanager:us-east-1:000000000000:secret:factory/prod/NOTION_API_KEY-AbC123'), 'NOTION_API_KEY');
    assert.equal(secretName('factory/prod/X'), 'X');
    assert.equal(secretName('X'), 'X');
  });
});
