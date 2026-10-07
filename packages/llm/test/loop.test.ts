import { describe, expect, it } from 'vitest';
import { converse, type LoopEvent, type ToolHandler, ToolError } from '../src';
import { lastResults, say, scriptedModel, useTool } from '../src/scripted';

const echo: ToolHandler = {
  def: { name: 'echo', description: 'echo', input_schema: { type: 'object' } },
  effect: 'read',
  handle: async (input) => JSON.stringify(input),
};
const picky: ToolHandler = {
  def: { name: 'picky', description: 'fails on bad input', input_schema: { type: 'object' } },
  effect: 'read',
  handle: async () => {
    throw new ToolError('bad input: try again with x');
  },
};

describe('converse', () => {
  it('runs tools, returns their results in order, and stops when the model stops calling tools', async () => {
    const events: LoopEvent[] = [];
    const model = scriptedModel((input, call) => {
      if (call === 0) return useTool('echo', { a: 1 }, 'checking');
      expect(lastResults(input)).toEqual([{ name: 'echo', content: '{"a":1}', is_error: false }]);
      return say('all done');
    });
    const c = await converse({ model, system: 'sys', prompt: 'go', tools: [echo], maxTurns: 5, onEvent: (e) => events.push(e) });
    expect(c.stop).toBe('end_turn');
    expect(c.finalText).toBe('all done');
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(events.map((e) => e.type)).toEqual(['turn', 'tool', 'turn']);
    expect(model.inputs[1]!.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', is_error: false });
  });

  it('answers an unknown tool and a ToolError with is_error results the model can recover from', async () => {
    const model = scriptedModel((input, call) => {
      if (call === 0) return useTool('update_vendor_bank_details', { iban: 'x' });
      if (call === 1) {
        expect(lastResults(input)[0]).toMatchObject({ is_error: true, content: 'unknown tool "update_vendor_bank_details"; available tools: echo, picky' });
        return useTool('picky', {});
      }
      expect(lastResults(input)[0]).toEqual({ name: 'picky', content: 'bad input: try again with x', is_error: true });
      return say('giving up');
    });
    expect((await converse({ model, system: 's', prompt: 'p', tools: [echo, picky], maxTurns: 5 })).stop).toBe('end_turn');
  });

  it('lets infrastructure errors end the conversation', async () => {
    const broken: ToolHandler = { ...echo, handle: async () => Promise.reject(new Error('api down')) };
    const model = scriptedModel(() => useTool('echo', {}));
    await expect(converse({ model, system: 's', prompt: 'p', tools: [broken], maxTurns: 3 })).rejects.toThrow('api down');
  });

  it('stops after maxTurns', async () => {
    const model = scriptedModel(() => useTool('echo', {}));
    const c = await converse({ model, system: 's', prompt: 'p', tools: [echo], maxTurns: 3 });
    expect([c.stop, model.inputs.length]).toEqual(['max_turns', 3]);
  });

  it('never executes a tool call from a turn cut off by max_tokens', async () => {
    let ran = 0;
    const counting: ToolHandler = { ...echo, handle: async () => String(++ran) };
    const model = scriptedModel(() => ({ ...useTool('echo', { partial: true }), stop: 'max_tokens' }));
    const c = await converse({ model, system: 's', prompt: 'p', tools: [counting], maxTurns: 3 });
    expect([c.stop, ran]).toEqual(['max_tokens', 0]);
  });
});
