import { describe, expect, it } from 'bun:test';
import { PIPELINE_SYSTEM_PROMPT, addressPrPrompt, pipelinePrompt } from './pipeline-prompts';

describe('pipelinePrompt', () => {
  it('names the next-task skill for Claude', () => {
    const prompt = pipelinePrompt('claude', 'task-1');
    expect(prompt).toContain('next-task');
    expect(prompt).toContain('task-1');
  });

  it('inlines the four-phase workflow for Codex without naming the next-task skill', () => {
    const prompt = pipelinePrompt('codex', 'task-1');
    expect(prompt).not.toContain('next-task');
    expect(prompt).toContain('committee-review');
    expect(prompt).toContain('address-pr');
    expect(prompt).toContain('task-1');
  });
});

describe('addressPrPrompt', () => {
  it('addresses a specific pull request number for a specific task id', () => {
    const prompt = addressPrPrompt('task-1', 42);
    expect(prompt).toContain('#42');
    expect(prompt).toContain('task-1');
    expect(prompt).toContain('address-pr');
  });
});

describe('PIPELINE_SYSTEM_PROMPT', () => {
  it('names the merge-or-stop contract', () => {
    expect(PIPELINE_SYSTEM_PROMPT).toContain('merged');
    expect(PIPELINE_SYSTEM_PROMPT).toContain('STUCK:');
  });
});
