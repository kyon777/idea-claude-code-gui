import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock, SubagentInfo, SubagentStatus } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { normalizeToolName } from '../utils/toolConstants';

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
}

function extractResultText(result?: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

function extractSpawnedAgentId(input: Record<string, unknown> | undefined, result: ToolResultBlock | null): string | undefined {
  const text = extractResultText(result)?.trim();
  let parsed: Record<string, unknown> | null = null;

  if (text && (text.startsWith('{') || text.startsWith('['))) {
    try {
      const candidate = JSON.parse(text);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  const values = [
    parsed?.agent_id,
    parsed?.agentId,
    parsed?.agent_path,
    parsed?.agentPath,
    input?.agent_id,
    input?.agentId,
    input?.agent_path,
    input?.agentPath,
  ];

  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return text?.match(/\b([0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1];
}

function extractWaitAgentTargets(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];

  const targets: string[] = [];
  const addTarget = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      targets.push(value.trim());
    }
  };

  addTarget(input.target);
  addTarget(input.agent_id);
  addTarget(input.agentId);

  if (Array.isArray(input.targets)) {
    input.targets.forEach(addTarget);
  }

  return targets;
}

function buildWaitAgentStatusMap(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
): Map<string, SubagentStatus> {
  const waitStatuses = new Map<string, SubagentStatus>();

  messages.forEach((message, messageIndex) => {
    if (message.type !== 'assistant') return;

    const blocks = getContentBlocks(message);
    blocks.forEach((block) => {
      if (block.type !== 'tool_use') return;
      if (normalizeToolName(block.name ?? '') !== 'wait_agent') return;

      const input = block.input as Record<string, unknown> | undefined;
      const targets = extractWaitAgentTargets(input);
      if (targets.length === 0) return;

      const result = findToolResult(block.id, messageIndex);
      if (!result) return;

      const status: SubagentStatus = result.is_error ? 'error' : 'completed';
      targets.forEach((target) => waitStatuses.set(target, status));
    });
  });

  return waitStatuses;
}

/**
 * Determine subagent status based on tool result and wait_agent completion.
 */
function determineStatus(
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: ToolResultBlock | null,
  waitStatuses: Map<string, SubagentStatus>,
): SubagentStatus {
  if (result?.is_error) {
    return 'error';
  }

  if (toolName === 'spawn_agent') {
    const agentId = extractSpawnedAgentId(input, result);
    if (agentId && waitStatuses.has(agentId)) {
      return waitStatuses.get(agentId) ?? 'running';
    }
    return 'running';
  }

  if (!result) {
    return 'running';
  }
  return 'completed';
}

export function extractSubagentsFromMessages(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
): SubagentInfo[] {
  const subagents: SubagentInfo[] = [];
  const waitStatuses = buildWaitAgentStatusMap(messages, getContentBlocks, findToolResult);

  messages.forEach((message, messageIndex) => {
    if (message.type !== 'assistant') return;

    const blocks = getContentBlocks(message);

    blocks.forEach((block) => {
      if (block.type !== 'tool_use') return;

      const toolName = normalizeToolName(block.name ?? '');

      // Only process task/agent-style subagent tool calls.
      if (toolName !== 'task' && toolName !== 'agent' && toolName !== 'spawn_agent') return;

      const rawInput = block.input as Record<string, unknown> | undefined;
      const input = rawInput ? normalizeToolInput(block.name, rawInput) as Record<string, unknown> : undefined;
      if (!input) return;

      // Defensive: ensure all string values are actually strings
      const id = String(block.id ?? `task-${messageIndex}-${subagents.length}`);
      const subagentType = String((input.subagent_type as string) ?? (input.subagentType as string) ?? 'Unknown');
      const description = String((input.description as string) ?? '');
      const prompt = String((input.prompt as string) ?? '');

      // Check tool result / wait_agent result to determine status
      const result = findToolResult(block.id, messageIndex);
      const status = determineStatus(toolName, input, result, waitStatuses);

      subagents.push({
        id,
        type: subagentType,
        description,
        prompt,
        status,
        messageIndex,
      });
    });
  });

  return subagents;
}

/**
 * Hook to extract subagent information from Task tool calls
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
}: UseSubagentsParams): SubagentInfo[] {
  return useMemo(
    () => extractSubagentsFromMessages(messages, getContentBlocks, findToolResult),
    [messages, getContentBlocks, findToolResult],
  );
}
