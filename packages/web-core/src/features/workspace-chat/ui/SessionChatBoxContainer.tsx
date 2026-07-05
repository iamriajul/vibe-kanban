import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import {
  type AskUserQuestionItem,
  BaseAgentCapability,
  type Session,
  type BaseCodingAgent,
  ExecutionProcessStatus,
} from 'shared/types';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { useWorkspaceExecution } from '@/shared/hooks/useWorkspaceExecution';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import WYSIWYGEditor from '@/shared/components/WYSIWYGEditor';
import { useApprovalFeedbackOptional } from '../model/contexts/ApprovalFeedbackContext';
import { useMessageEditContext } from '../model/contexts/MessageEditContext';
import { useEntries, useTokenUsage } from '../model/contexts/EntriesContext';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { useReviewOptional } from '@/shared/hooks/useReview';
import { useActions } from '@/shared/hooks/useActions';
import { useTodos } from '../model/hooks/useTodos';
import { getLatestConfigFromProcesses } from '@/shared/lib/executor';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { useSessionMessageEditor } from '../model/hooks/useSessionMessageEditor';
import { useSessionQueueInteraction } from '../model/hooks/useSessionQueueInteraction';
import { useSessionSend } from '../model/hooks/useSessionSend';
import { useSessionAttachments } from '../model/hooks/useSessionAttachments';
import { useMessageEditRetry } from '../model/hooks/useMessageEditRetry';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useWorkspaceBranch } from '../model/hooks/useWorkspaceBranch';
import { useApprovalMutation } from '../model/hooks/useApprovalMutation';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { ResolveConflictsDialog } from '@/shared/dialogs/tasks/ResolveConflictsDialog';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { buildAgentPrompt } from '@/shared/lib/promptMessage';
import { formatDateShortWithTime } from '@/shared/lib/date';
import { toPrettyCase } from '@/shared/lib/string';
import {
  SessionChatBox,
  type ExecutionStatus,
  type SessionChatBoxEditorRenderProps,
} from '@vibe/ui/components/SessionChatBox';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';
import {
  useWorkspacePanelState,
  RIGHT_MAIN_PANEL_MODES,
} from '@/shared/stores/useUiPreferencesStore';
import { useInspectModeStore } from '../model/store/useInspectModeStore';
import { Actions } from '@/shared/actions';
import {
  isSpecialIcon,
  getActionTooltip,
  isActionEnabled,
  isActionVisible,
  type ActionDefinition,
} from '@/shared/types/actions';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { useActionVisibilityContext } from '@/shared/hooks/useActionVisibilityContext';
import { PrCommentsDialog } from '@/shared/dialogs/tasks/PrCommentsDialog';
import type { NormalizedComment } from '@vibe/ui/components/pr-comment-node';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { executionProcessesApi, sessionsApi } from '@/shared/lib/api';
import { RenameSessionDialog } from '@vibe/ui/components/RenameSessionDialog';
import type { TurnNavigationItem } from '@vibe/ui/components/TurnNavigationPopup';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { useModelSelectorConfig } from '@/shared/hooks/useExecutorDiscovery';
import {
  appendPresetModel,
  getSelectedModel,
  parseModelId,
  resolveDefaultModelId,
} from '@/shared/lib/modelSelector';

type MigrationHistoryComponent =
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool'
  | 'approval'
  | 'error'
  | 'summary'
  | 'rawLog'
  | 'thinking';

type MigrationHistorySelection = Record<MigrationHistoryComponent, boolean>;

const MIGRATION_HISTORY_OPTIONS: Array<{
  key: MigrationHistoryComponent;
  label: string;
  required?: boolean;
}> = [
  { key: 'user', label: 'User messages', required: true },
  { key: 'assistant', label: 'Assistant messages' },
  { key: 'system', label: 'System messages' },
  { key: 'tool', label: 'Tool calls and results' },
  { key: 'approval', label: 'Approvals, feedback, and answers' },
  { key: 'error', label: 'Errors' },
  { key: 'summary', label: 'Summaries' },
  { key: 'rawLog', label: 'Raw command logs' },
  { key: 'thinking', label: 'AI thinking' },
];

const DEFAULT_MIGRATION_HISTORY_SELECTION: MigrationHistorySelection = {
  user: true,
  assistant: true,
  system: false,
  tool: false,
  approval: false,
  error: false,
  summary: false,
  rawLog: false,
  thinking: false,
};

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

/** Compute execution status from boolean flags */
function computeExecutionStatus(params: {
  isInFeedbackMode: boolean;
  isInEditMode: boolean;
  isStopping: boolean;
  isQueueLoading: boolean;
  isSendingFollowUp: boolean;
  isQueued: boolean;
  isAttemptRunning: boolean;
}): ExecutionStatus {
  if (params.isInFeedbackMode) return 'feedback';
  if (params.isInEditMode) return 'edit';
  if (params.isStopping) return 'stopping';
  if (params.isQueueLoading) return 'queue-loading';
  if (params.isSendingFollowUp) return 'sending';
  if (params.isQueued) return 'queued';
  if (params.isAttemptRunning) return 'running';
  return 'idle';
}

function classifyHistoryEntry(
  entry: PatchTypeWithKey
): MigrationHistoryComponent | null {
  if (entry.type === 'STDOUT' || entry.type === 'STDERR') return 'rawLog';
  if (entry.type === 'DIFF') return 'tool';
  if (entry.type !== 'NORMALIZED_ENTRY') return null;

  switch (entry.content.entry_type.type) {
    case 'user_message':
      return 'user';
    case 'assistant_message':
      return 'assistant';
    case 'system_message':
      return 'system';
    case 'tool_use':
      return 'tool';
    case 'user_feedback':
    case 'user_answered_questions':
      return 'approval';
    case 'error_message':
      return 'error';
    case 'thinking':
      return 'thinking';
    case 'next_action':
    case 'token_usage_info':
      return 'summary';
    case 'loading':
      return null;
  }
}

function formatHistoryEntry(entry: PatchTypeWithKey): string | null {
  if (entry.type === 'STDOUT' || entry.type === 'STDERR') {
    return `<log stream="${entry.type.toLowerCase()}">\n${entry.content.trim()}\n</log>`;
  }

  if (entry.type === 'DIFF') {
    return `<tool>\n${JSON.stringify(entry.content, null, 2)}\n</tool>`;
  }

  if (entry.type !== 'NORMALIZED_ENTRY') return null;

  const normalized = entry.content;
  const entryType = normalized.entry_type;
  const content = normalized.content.trim();

  switch (entryType.type) {
    case 'user_message':
      return `<user>\n${content}\n</user>`;
    case 'assistant_message':
      return `<agent>\n${content}\n</agent>`;
    case 'system_message':
      return `<system>\n${content}\n</system>`;
    case 'thinking':
      return `<thinking>\n${content}\n</thinking>`;
    case 'tool_use':
      return [
        `<tool name="${escapeXmlAttribute(entryType.tool_name)}">`,
        `<status>${escapeXmlText(JSON.stringify(entryType.status))}</status>`,
        `<action>${escapeXmlText(JSON.stringify(entryType.action_type, null, 2))}</action>`,
        content ? `Content:\n${content}` : null,
        '</tool>',
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    case 'user_feedback':
      return `<approval type="feedback" denied_tool="${escapeXmlAttribute(entryType.denied_tool)}">\n${content}\n</approval>`;
    case 'user_answered_questions':
      return `<approval type="answers">\n${JSON.stringify(entryType.answers, null, 2)}${content ? `\n${content}` : ''}\n</approval>`;
    case 'error_message':
      return `<error type="${escapeXmlAttribute(JSON.stringify(entryType.error_type))}">\n${content}\n</error>`;
    case 'next_action':
      return `<summary>\n${content || JSON.stringify(entryType, null, 2)}\n</summary>`;
    case 'token_usage_info':
      return `<summary type="token_usage">\n${JSON.stringify(entryType, null, 2)}\n</summary>`;
    case 'loading':
      return null;
  }
}

function escapeXmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function buildMigratedPrompt(
  entries: PatchTypeWithKey[],
  selection: MigrationHistorySelection,
  userPrompt: string
) {
  const migratedEntries = entries
    .filter((entry) => {
      const component = classifyHistoryEntry(entry);
      return component ? selection[component] : false;
    })
    .map(formatHistoryEntry)
    .filter((entry): entry is string => Boolean(entry));

  const migratedContext = migratedEntries.length
    ? migratedEntries.join('\n\n')
    : 'No previous transcript entries were selected.';

  return [
    'The following context was migrated from a previous Vibe Kanban session.',
    '',
    '<context>',
    migratedContext,
    '</context>',
    '',
    'Continue from that context and respond to this new prompt:',
    '',
    '<prompt>',
    userPrompt.trim(),
    '</prompt>',
  ].join('\n');
}

function estimateTokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) {
    const formatted = value / 1_000_000;
    return `${Number.isInteger(formatted) ? formatted.toFixed(0) : formatted.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const formatted = value / 1_000;
    return `${Number.isInteger(formatted) ? formatted.toFixed(0) : formatted.toFixed(1)}K`;
  }
  return value.toLocaleString();
}

type ModelInfoWithContextWindow = {
  id: string;
  name: string;
  context_window?: number | null;
  contextWindow?: number | null;
  model_context_window?: number | null;
  max_context_tokens?: number | null;
};

function inferKnownContextWindow(modelId: string, modelName: string) {
  const value = `${modelId} ${modelName}`.toLowerCase();
  if (value.includes('gemini') && value.includes('flash')) return 1_000_000;
  if (value.includes('opus[1m]') || value.includes('1m context')) {
    return 1_000_000;
  }
  return null;
}

function getModelContextWindow(model: ModelInfoWithContextWindow | null) {
  if (!model) return null;
  const explicit =
    model.context_window ??
    model.contextWindow ??
    model.model_context_window ??
    model.max_context_tokens;
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return inferKnownContextWindow(model.id, model.name);
}

/** Shared props across all modes */
interface SharedProps {
  /** Available sessions for this workspace */
  sessions: Session[];
  /** Number of files changed in current session */
  filesChanged: number;
  /** Number of lines added */
  linesAdded: number;
  /** Number of lines removed */
  linesRemoved: number;
  /** Callback to scroll to previous user message */
  onScrollToPreviousMessage: () => void;
  /** Callback to scroll to bottom of conversation */
  onScrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  /** Callback to scroll to a specific user message by patchKey */
  onScrollToUserMessage: (patchKey: string) => void;
  /** Returns the patchKey of the user message currently visible in the viewport */
  getActiveTurnPatchKey?: () => string | null;
  /** Disable the "view code" click handler (for VS Code extension) */
  disableViewCode: boolean;
  /** Replace diff stats with an "Open Workspace" button in header */
  showOpenWorkspaceButton: boolean;
}

/** Props for existing session mode */
interface ExistingSessionProps extends SharedProps {
  mode: 'existing-session';
  /** The current session */
  session: Session;
  /** Called when a session is selected */
  onSelectSession: (sessionId: string) => void;
  /** Callback to start new session mode */
  onStartNewSession: (() => void) | undefined;
}

/** Props for new session mode */
interface NewSessionProps extends SharedProps {
  mode: 'new-session';
  /** Workspace ID for creating new sessions */
  workspaceId: string;
  /** Called when a session is selected */
  onSelectSession: (sessionId: string) => void;
}

/** Props for placeholder mode (no workspace selected) */
interface PlaceholderProps extends SharedProps {
  mode: 'placeholder';
}

type SessionChatBoxContainerProps =
  | ExistingSessionProps
  | NewSessionProps
  | PlaceholderProps;

export function SessionChatBoxContainer(props: SessionChatBoxContainerProps) {
  const {
    mode,
    sessions,
    filesChanged,
    linesAdded,
    linesRemoved,
    onScrollToPreviousMessage,
    onScrollToBottom,
    onScrollToUserMessage,
    getActiveTurnPatchKey,
    disableViewCode = false,
    showOpenWorkspaceButton,
  } = props;

  // Extract mode-specific values
  const session = mode === 'existing-session' ? props.session : undefined;
  const workspaceId =
    mode === 'existing-session'
      ? props.session.workspace_id
      : mode === 'new-session'
        ? props.workspaceId
        : undefined;
  const isNewSessionMode = mode === 'new-session';
  const onSelectSession =
    mode === 'placeholder' ? undefined : props.onSelectSession;
  const onStartNewSession =
    mode === 'existing-session' ? props.onStartNewSession : undefined;

  const sessionId = session?.id;
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const [migrationHistorySelection, setMigrationHistorySelection] =
    useState<MigrationHistorySelection>(DEFAULT_MIGRATION_HISTORY_SELECTION);
  const [isMigratingToNewSession, setIsMigratingToNewSession] =
    useState(false);
  const [steerError, setSteerError] = useState<string | null>(null);

  const handleRenameSession = useCallback(
    (targetSessionId: string, currentName: string) => {
      void RenameSessionDialog.show({
        currentName,
        onRename: async (newName: string) => {
          await sessionsApi.update(targetSessionId, { name: newName });
          void queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
        },
      });
    },
    [queryClient, hostId, workspaceId]
  );
  const appNavigation = useAppNavigation();

  const { executeAction } = useActions();
  const actionCtx = useActionVisibilityContext();
  const { rightMainPanelMode, setRightMainPanelMode } =
    useWorkspacePanelState(workspaceId);

  const handleViewCode = useCallback(() => {
    setRightMainPanelMode(
      rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES
        ? null
        : RIGHT_MAIN_PANEL_MODES.CHANGES
    );
  }, [rightMainPanelMode, setRightMainPanelMode]);

  const handleOpenWorkspace = useCallback(() => {
    if (!workspaceId) return;
    appNavigation.goToWorkspace(workspaceId);
  }, [appNavigation, workspaceId]);

  // Get entries early to extract pending approval for scratch key
  const { entries } = useEntries();
  const tokenUsageInfo = useTokenUsage();

  // Extract user messages for turn navigation
  const userMessageTurns: TurnNavigationItem[] = useMemo(() => {
    let turnNumber = 0;
    return entries
      .filter(
        (entry) =>
          entry.type === 'NORMALIZED_ENTRY' &&
          entry.content.entry_type.type === 'user_message'
      )
      .map((entry) => {
        turnNumber++;
        return {
          patchKey: entry.patchKey,
          content:
            entry.type === 'NORMALIZED_ENTRY' ? entry.content.content : '',
          turnNumber,
        };
      });
  }, [entries]);

  // Execution state
  const { isAttemptRunning, stopExecution, isStopping, processes } =
    useWorkspaceExecution(workspaceId);

  // Approvals state
  const { getPendingForProcess } = useApprovals();

  // Get pending approval from running processes
  const pendingApproval = useMemo(() => {
    const runningProcesses = processes.filter(
      (p) => p.status === ExecutionProcessStatus.running
    );
    for (const proc of runningProcesses) {
      const info = getPendingForProcess(proc.id);
      if (info) {
        let questions: AskUserQuestionItem[] | undefined;
        for (const entry of entries) {
          if (entry.type !== 'NORMALIZED_ENTRY') continue;
          const entryType = entry.content.entry_type;
          if (
            entryType.type === 'tool_use' &&
            entryType.status.status === 'pending_approval' &&
            entryType.status.approval_id === info.approval_id &&
            entryType.action_type.action === 'ask_user_question'
          ) {
            questions = entryType.action_type.questions;
            break;
          }
        }
        return {
          approvalId: info.approval_id,
          timeoutAt: info.timeout_at,
          executionProcessId: info.execution_process_id,
          questions,
        };
      }
    }
    return null;
  }, [processes, getPendingForProcess, entries]);

  // Use approval_id as scratch key when pending approval exists to avoid
  // prefilling approval response with queued follow-up message
  const scratchId = useMemo(() => {
    if (pendingApproval?.approvalId) {
      return pendingApproval.approvalId;
    }
    return isNewSessionMode ? workspaceId : sessionId;
  }, [pendingApproval?.approvalId, isNewSessionMode, workspaceId, sessionId]);

  // Get repos for file search
  const { repos } = useWorkspaceRepo(workspaceId);
  const repoIds = repos.map((r) => r.id);

  // Approval feedback context
  const feedbackContext = useApprovalFeedbackOptional();
  const isInFeedbackMode = !!feedbackContext?.activeApproval;

  // Message edit context
  const editContext = useMessageEditContext();
  const isInEditMode = editContext.isInEditMode;

  // Get todos from entries
  const { todos, inProgressTodo } = useTodos(entries);

  // Review comments context (optional - only available when ReviewProvider wraps this)
  const reviewContext = useReviewOptional();
  const reviewMarkdown = useMemo(
    () => reviewContext?.generateReviewMarkdown() ?? '',
    [reviewContext]
  );
  const hasReviewComments = (reviewContext?.comments.length ?? 0) > 0;

  // Approval mutation for approve/deny/answer actions
  const {
    approveAsync,
    denyAsync,
    answerAsync,
    isApproving,
    isDenying,
    isAnswering,
    denyError,
    answerError,
  } = useApprovalMutation();

  // Branch status for edit retry and conflict detection
  const { data: branchStatus } = useBranchStatus(workspaceId);

  // Derive conflict state from branch status
  const hasConflicts = useMemo(() => {
    return (
      branchStatus?.some((r) => (r.conflicted_files?.length ?? 0) > 0) ?? false
    );
  }, [branchStatus]);

  const conflictedFilesCount = useMemo(() => {
    return (
      branchStatus?.reduce(
        (sum, r) => sum + (r.conflicted_files?.length ?? 0),
        0
      ) ?? 0
    );
  }, [branchStatus]);

  // Get workspace branch for conflict resolution dialog
  const { branch: attemptBranch } = useWorkspaceBranch(workspaceId);

  // Find the first repo with conflicts (for the resolve dialog)
  const repoWithConflicts = useMemo(
    () =>
      branchStatus?.find(
        (r) => r.is_rebase_in_progress || (r.conflicted_files?.length ?? 0) > 0
      ),
    [branchStatus]
  );

  const handleResolveConflicts = useCallback(() => {
    if (!workspaceId || !repoWithConflicts) return;
    ResolveConflictsDialog.show({
      workspaceId,
      conflictOp: repoWithConflicts.conflict_op ?? 'rebase',
      sourceBranch: attemptBranch,
      targetBranch: repoWithConflicts.target_branch_name,
      conflictedFiles: repoWithConflicts.conflicted_files ?? [],
      repoName: repoWithConflicts.repo_name,
    });
  }, [workspaceId, repoWithConflicts, attemptBranch]);

  // User profiles, config preference, and latest executor from processes
  const { profiles, config, capabilities } = useUserSystem();

  // Fetch processes from last session to get full profile (only in new session mode)
  const lastSessionId = isNewSessionMode ? sessions?.[0]?.id : undefined;
  const { executionProcesses: lastSessionProcesses } =
    useExecutionProcesses(lastSessionId);

  // Compute latestConfig: current processes > last session processes > session metadata
  const latestConfig = useMemo(() => {
    // Current session's processes take priority (full ExecutorConfig)
    const fromProcesses = getLatestConfigFromProcesses(processes);
    if (fromProcesses) return fromProcesses;

    // Try full config from last session's processes
    const fromLastSession = getLatestConfigFromProcesses(lastSessionProcesses);
    if (fromLastSession) return fromLastSession;

    // Fallback: just executor from session metadata
    const lastSessionExecutor = sessions?.[0]?.executor;
    if (lastSessionExecutor) {
      return {
        executor: lastSessionExecutor as BaseCodingAgent,
      };
    }

    return null;
  }, [processes, lastSessionProcesses, sessions]);

  const needsExecutorSelection =
    isNewSessionMode || (!session?.executor && !latestConfig?.executor);

  // Message editor state
  const {
    localMessage,
    setLocalMessage,
    scratchData,
    isScratchLoading,
    hasInitialValue,
    saveToScratch,
    clearDraft,
    cancelDebouncedSave,
    handleMessageChange,
  } = useSessionMessageEditor({ scratchId });

  // Ref to access current message value for attachment handler
  const localMessageRef = useRef(localMessage);
  useEffect(() => {
    localMessageRef.current = localMessage;
  }, [localMessage]);

  // Attachment handling - insert markdown when attachments are uploaded
  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      const currentMessage = localMessageRef.current;
      const newMessage = currentMessage.trim()
        ? `${currentMessage}\n\n${markdown}`
        : markdown;
      setLocalMessage(newMessage);
    },
    [setLocalMessage]
  );

  // Auto-paste component context from inspect mode
  const pendingComponentMarkdown = useInspectModeStore(
    (s) => s.pendingComponentMarkdown
  );
  const clearPendingComponentMarkdown = useInspectModeStore(
    (s) => s.clearPendingComponentMarkdown
  );

  useEffect(() => {
    if (pendingComponentMarkdown) {
      handleInsertMarkdown(pendingComponentMarkdown);
      clearPendingComponentMarkdown();
    }
  }, [
    pendingComponentMarkdown,
    handleInsertMarkdown,
    clearPendingComponentMarkdown,
  ]);

  const { uploadFiles, localAttachments, clearUploadedAttachments } =
    useSessionAttachments(workspaceId, sessionId, handleInsertMarkdown);

  // Unified executor + variant + model selector options resolution
  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    presetOptions,
    setExecutor: handleExecutorChange,
    setVariant: setSelectedVariant,
    setOverrides: setExecutorOverrides,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: latestConfig,
    scratchConfig: scratchData?.executor_config ?? undefined,
    configExecutorProfile: config?.executor_profile,
    onPersist: (cfg) => void saveToScratch(localMessageRef.current, cfg),
  });

  const currentSessionExecutor = useMemo(() => {
    const value = session?.executor ?? latestConfig?.executor ?? null;
    return value ? (value as BaseCodingAgent) : null;
  }, [latestConfig?.executor, session?.executor]);

  const isMigrationMode =
    mode === 'existing-session' &&
    !!currentSessionExecutor &&
    !!effectiveExecutor &&
    (isMigratingToNewSession || effectiveExecutor !== currentSessionExecutor);

  useEffect(() => {
    if (mode !== 'existing-session') {
      setIsMigratingToNewSession(false);
    }
  }, [mode]);

  const {
    config: migrationStreamModelConfig,
  } = useModelSelectorConfig(effectiveExecutor, {
    workspaceId: sessionId ? workspaceId : undefined,
    sessionId,
  });

  const targetModelContextWindow = useMemo(() => {
    const modelConfig = appendPresetModel(
      migrationStreamModelConfig,
      presetOptions?.model_id
    );
    if (!modelConfig) return null;

    const hasProviders = modelConfig.providers.length > 0;
    const { providerId: configProviderId, modelId: configModelId } =
      parseModelId(executorConfig?.model_id, hasProviders);
    const { providerId: presetProviderId, modelId: presetModelId } =
      parseModelId(presetOptions?.model_id, hasProviders);
    const selectedProviderId =
      configProviderId ?? presetProviderId ?? modelConfig.providers[0]?.id ?? null;
    const selectedModelId =
      configModelId ??
      presetModelId ??
      resolveDefaultModelId(
        modelConfig.models,
        selectedProviderId,
        modelConfig.default_model,
        hasProviders
      );
    const selectedModel = getSelectedModel(
      modelConfig.models,
      selectedProviderId,
      selectedModelId
    );

    return getModelContextWindow(selectedModel);
  }, [
    executorConfig?.model_id,
    migrationStreamModelConfig,
    presetOptions?.model_id,
  ]);

  const migrationEntryCounts = useMemo(() => {
    const counts: Record<MigrationHistoryComponent, number> = {
      user: 0,
      assistant: 0,
      system: 0,
      tool: 0,
      approval: 0,
      error: 0,
      summary: 0,
      rawLog: 0,
      thinking: 0,
    };

    for (const entry of entries) {
      const component = classifyHistoryEntry(entry);
      if (component) counts[component] += 1;
    }

    return counts;
  }, [entries]);

  const handleMigrationHistorySelectionChange = useCallback(
    (key: MigrationHistoryComponent, checked: boolean) => {
      if (key === 'user') return;
      setMigrationHistorySelection((current) => ({
        ...current,
        [key]: checked,
      }));
    },
    []
  );

  const migrationPromptPreview = useMemo(() => {
    const { prompt } = buildAgentPrompt(localMessage, [reviewMarkdown]);
    return buildMigratedPrompt(entries, migrationHistorySelection, prompt);
  }, [entries, localMessage, migrationHistorySelection, reviewMarkdown]);

  const migrationEstimatedTokens = useMemo(
    () => estimateTokenCount(migrationPromptPreview),
    [migrationPromptPreview]
  );

  const migrationContextUsagePercent = targetModelContextWindow
    ? Math.min(
        100,
        Math.round((migrationEstimatedTokens / targetModelContextWindow) * 100)
      )
    : null;

  const handleMigrateToNewSession = useCallback(() => {
    if (mode !== 'existing-session') return;
    setIsMigratingToNewSession(true);
  }, [mode]);

  const migrationNotice = isMigrationMode ? (
    <div className="px-double py-base space-y-base">
      <div className="space-y-half">
        <div className="text-sm font-medium text-normal">
          Sending with{' '}
          {effectiveExecutor
            ? toPrettyCase(effectiveExecutor)
            : 'another executor'}{' '}
          will create a new session.
        </div>
        <div className="text-xs text-low">
          Selected history will be copied into the new session, and your prompt
          will be appended at the bottom.
        </div>
      </div>
      <div className="space-y-half">
        {targetModelContextWindow ? (
          <div className="space-y-half">
            <div className="relative h-5 overflow-hidden rounded-sm border border-border bg-secondary">
              <div
                className="h-full bg-brand/70"
                style={{ width: `${migrationContextUsagePercent ?? 0}%` }}
              />
              <div className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-normal">
                {migrationContextUsagePercent}% ·{' '}
                {formatTokenCount(migrationEstimatedTokens)} /{' '}
                {formatTokenCount(targetModelContextWindow)}
              </div>
            </div>
            <div className="text-xs text-low">
              Estimated migrated prompt size against the target model context.
            </div>
          </div>
        ) : (
          <div className="text-xs text-low">
            Estimated migrated prompt size:{' '}
            <span className="font-medium text-normal">
              {formatTokenCount(migrationEstimatedTokens)} tokens
            </span>
            . Target context window is not known.
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-double gap-y-half">
        {MIGRATION_HISTORY_OPTIONS.map((option) => {
          const count = migrationEntryCounts[option.key];
          const disabled = option.required || count === 0;
          return (
            <label
              key={option.key}
              className="flex items-center gap-2 text-xs text-normal"
            >
              <Checkbox
                checked={migrationHistorySelection[option.key]}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  handleMigrationHistorySelectionChange(option.key, checked)
                }
              />
              <span className={count === 0 ? 'text-low' : undefined}>
                {option.label}
                <span className="text-low"> ({count})</span>
              </span>
            </label>
          );
        })}
      </div>
      <details className="rounded-sm border border-border bg-secondary/60">
        <summary className="cursor-pointer px-base py-half text-xs font-medium text-normal">
          Preview migrated prompt
        </summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border px-base py-half text-[11px] leading-relaxed text-low">
          {migrationPromptPreview}
        </pre>
      </details>
    </div>
  ) : null;

  const supportsContextUsage =
    !!effectiveExecutor &&
    capabilities?.[effectiveExecutor]?.includes(
      BaseAgentCapability.CONTEXT_USAGE
    );

  const runningSteerableProcess = useMemo(() => {
    return (
      processes.find((process) => {
        if (process.status !== ExecutionProcessStatus.running) return false;
        const action = process.executor_action.typ;
        const executor =
          action.type === 'CodingAgentInitialRequest' ||
          action.type === 'CodingAgentFollowUpRequest' ||
          action.type === 'ReviewRequest'
            ? action.executor_config.executor
            : null;
        return (
          !!executor &&
          capabilities?.[executor]?.includes(BaseAgentCapability.AGENT_STEERING)
        );
      }) ?? null
    );
  }, [capabilities, processes]);

  const canSteerRunningAgent =
    !!runningSteerableProcess && !isMigrationMode && !pendingApproval;

  // Navigate to agent settings to customise variants
  const handleCustomise = () => {
    SettingsDialog.show({ initialSection: 'agents' });
  };

  // Queue interaction
  const {
    isQueued,
    queuedMessage,
    queuedConfig,
    isQueueLoading,
    queueMessage,
    cancelQueue,
    refreshQueueStatus,
  } = useSessionQueueInteraction({ sessionId });

  // Send actions
  const {
    send,
    isSending,
    error: sendError,
    clearError,
  } = useSessionSend({
    sessionId,
    workspaceId,
    isNewSessionMode,
    onSelectSession,
    executorConfig,
  });

  const steerMutation = useMutation({
    mutationFn: ({
      processId,
      message,
    }: {
      processId: string;
      message: string;
    }) => executionProcessesApi.steerExecutionProcess(processId, message),
  });

  const handleSend = useCallback(async () => {
    const { prompt, isSlashCommand } = buildAgentPrompt(localMessage, [
      reviewMarkdown,
    ]);

    onScrollToBottom('auto');

    const finalPrompt = isMigrationMode
      ? buildMigratedPrompt(entries, migrationHistorySelection, prompt)
      : prompt;
    const success = await send(finalPrompt, {
      createNewSession: isMigrationMode,
      sessionName:
        isMigrationMode && currentSessionExecutor && effectiveExecutor
          ? `Migrated from ${toPrettyCase(currentSessionExecutor)} to ${toPrettyCase(effectiveExecutor)}`
          : undefined,
    });
    if (success) {
      cancelDebouncedSave();
      setLocalMessage('');
      clearUploadedAttachments();
      if (isNewSessionMode || isMigrationMode) await clearDraft();
      if (isMigrationMode) setIsMigratingToNewSession(false);
      if (!isSlashCommand) {
        reviewContext?.clearComments();
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onScrollToBottom('auto');
        });
      });
    }
  }, [
    onScrollToBottom,
    send,
    localMessage,
    reviewMarkdown,
    isMigrationMode,
    entries,
    migrationHistorySelection,
    currentSessionExecutor,
    effectiveExecutor,
    cancelDebouncedSave,
    setLocalMessage,
    clearUploadedAttachments,
    isNewSessionMode,
    clearDraft,
    setIsMigratingToNewSession,
    reviewContext,
  ]);

  const handleSteer = useCallback(async () => {
    if (!runningSteerableProcess) return;
    const { prompt, isSlashCommand } = buildAgentPrompt(localMessage, [
      reviewMarkdown,
    ]);
    const trimmed = prompt.trim();
    if (!trimmed) return;

    try {
      setSteerError(null);
      await steerMutation.mutateAsync({
        processId: runningSteerableProcess.id,
        message: trimmed,
      });
      cancelDebouncedSave();
      setLocalMessage('');
      await clearDraft();
      clearUploadedAttachments();
      if (!isSlashCommand) {
        reviewContext?.clearComments();
      }
      onScrollToBottom('auto');
    } catch (e: unknown) {
      const err = e as { message?: string };
      setSteerError(`Failed to steer agent: ${err.message ?? 'Unknown error'}`);
    }
  }, [
    runningSteerableProcess,
    localMessage,
    reviewMarkdown,
    steerMutation,
    cancelDebouncedSave,
    setLocalMessage,
    clearDraft,
    clearUploadedAttachments,
    reviewContext,
    onScrollToBottom,
  ]);

  // Track previous process count for queue refresh
  const prevProcessCountRef = useRef(processes.length);

  // Refresh queue status when execution stops or new process starts
  useEffect(() => {
    const prevCount = prevProcessCountRef.current;
    prevProcessCountRef.current = processes.length;

    if (!workspaceId) return;

    if (!isAttemptRunning) {
      refreshQueueStatus();
      return;
    }

    if (processes.length > prevCount) {
      refreshQueueStatus();
    }
  }, [isAttemptRunning, workspaceId, processes.length, refreshQueueStatus]);

  // Queue message handler
  const handleQueueMessage = useCallback(async () => {
    // Allow queueing if there's a message OR review comments, and we have a config
    if ((!localMessage.trim() && !reviewMarkdown) || !executorConfig) return;

    const { prompt } = buildAgentPrompt(localMessage, [reviewMarkdown]);

    cancelDebouncedSave();
    await saveToScratch(localMessage, executorConfig);
    await queueMessage(prompt, executorConfig);

    // Clear local state after queueing (same as handleSend)
    setLocalMessage('');
    clearUploadedAttachments();
    reviewContext?.clearComments();
  }, [
    localMessage,
    reviewMarkdown,
    executorConfig,
    queueMessage,
    cancelDebouncedSave,
    saveToScratch,
    setLocalMessage,
    clearUploadedAttachments,
    reviewContext,
  ]);

  // Editor change handler
  const handleEditorChange = useCallback(
    (value: string) => {
      if (isQueued) cancelQueue();
      if (executorConfig) {
        handleMessageChange(value, executorConfig);
      } else {
        setLocalMessage(value);
      }
      if (sendError) clearError();
      if (steerError) setSteerError(null);
    },
    [
      isQueued,
      cancelQueue,
      handleMessageChange,
      executorConfig,
      sendError,
      clearError,
      steerError,
      setLocalMessage,
    ]
  );

  // Handle feedback submission
  const handleSubmitFeedback = useCallback(async () => {
    if (!feedbackContext || !localMessage.trim()) return;
    try {
      await feedbackContext.submitFeedback(localMessage);
      cancelDebouncedSave();
      setLocalMessage('');
      await clearDraft();
    } catch {
      // Error is handled in context
    }
  }, [
    feedbackContext,
    localMessage,
    cancelDebouncedSave,
    setLocalMessage,
    clearDraft,
  ]);

  // Handle cancel feedback mode
  const handleCancelFeedback = useCallback(() => {
    feedbackContext?.exitFeedbackMode();
  }, [feedbackContext]);

  // Handle cancel queue - restore message to editor
  const handleCancelQueue = useCallback(async () => {
    if (queuedMessage) {
      setLocalMessage(queuedMessage);
    }
    if (queuedConfig) {
      setExecutorOverrides(queuedConfig);
    }
    await cancelQueue();
  }, [
    queuedMessage,
    queuedConfig,
    setLocalMessage,
    setExecutorOverrides,
    cancelQueue,
  ]);

  // Message edit retry mutation
  const editRetryMutation = useMessageEditRetry(sessionId ?? '', () => {
    // On success, clear edit mode and reset editor
    editContext.cancelEdit();
    cancelDebouncedSave();
    setLocalMessage('');
  });

  const areAttachmentInputsDisabled =
    mode === 'placeholder' ||
    isQueued ||
    isSending ||
    isStopping ||
    !!feedbackContext?.isSubmitting ||
    editRetryMutation.isPending ||
    isApproving ||
    isDenying ||
    isAnswering;

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        uploadFiles(acceptedFiles);
      }
    },
    [uploadFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: areAttachmentInputsDisabled,
    noClick: true,
    noKeyboard: true,
  });

  // Handle edit submission
  const handleSubmitEdit = useCallback(async () => {
    if (!editContext.activeEdit || !localMessage.trim() || !executorConfig)
      return;
    editRetryMutation.mutate({
      message: localMessage,
      executorConfig,
      executionProcessId: editContext.activeEdit.processId,
      branchStatus,
      processes,
    });
  }, [
    editContext.activeEdit,
    localMessage,
    executorConfig,
    branchStatus,
    processes,
    editRetryMutation,
  ]);

  // Handle cancel edit mode
  const handleCancelEdit = useCallback(() => {
    editContext.cancelEdit();
    setLocalMessage('');
  }, [editContext, setLocalMessage]);

  // Populate editor with original message when entering edit mode
  const prevEditRef = useRef(editContext.activeEdit);
  useEffect(() => {
    if (editContext.activeEdit && !prevEditRef.current) {
      // Just entered edit mode - populate with original message
      setLocalMessage(editContext.activeEdit.originalMessage);
    }
    prevEditRef.current = editContext.activeEdit;
  }, [editContext.activeEdit, setLocalMessage]);

  // Handle inserting PR comments into the message editor
  const handleInsertPrComments = useCallback(async () => {
    if (!workspaceId) return;
    const repoId = repos[0]?.id;
    if (!repoId) return;

    const result = await PrCommentsDialog.show({
      workspaceId: workspaceId,
      repoId,
    });
    if (result.comments.length > 0) {
      const markdownBlocks = result.comments.map((comment) => {
        const payload: NormalizedComment = {
          id:
            comment.comment_type === 'general'
              ? comment.id
              : comment.id.toString(),
          comment_type: comment.comment_type,
          author: comment.author,
          body: comment.body,
          created_at: comment.created_at,
          url: comment.url,
          ...(comment.comment_type === 'review' && {
            path: comment.path,
            line: comment.line != null ? Number(comment.line) : null,
            diff_hunk: comment.diff_hunk,
          }),
        };
        return '```gh-comment\n' + JSON.stringify(payload, null, 2) + '\n```';
      });
      handleInsertMarkdown(markdownBlocks.join('\n\n'));
    }
  }, [workspaceId, repos, handleInsertMarkdown]);

  // Toolbar actions handler
  const handleToolbarAction = useCallback(
    (action: ActionDefinition) => {
      if (action.requiresTarget && workspaceId) {
        executeAction(action, workspaceId);
      } else {
        executeAction(action);
      }
    },
    [executeAction, workspaceId]
  );

  // Define which actions appear in the toolbar
  const toolbarActionsList = useMemo(
    () =>
      [Actions.StartReview].filter((action) =>
        isActionVisible(action, actionCtx)
      ),
    [actionCtx]
  );

  const toolbarActionItems = useMemo(
    () =>
      toolbarActionsList.flatMap((action) => {
        if (isSpecialIcon(action.icon)) {
          return [];
        }

        const label = action.label;

        return [
          {
            id: action.id,
            icon: action.icon,
            label,
            tooltip: getActionTooltip(action, actionCtx),
            disabled: !isActionEnabled(action, actionCtx),
            onClick: () => handleToolbarAction(action),
          },
        ];
      }),
    [toolbarActionsList, actionCtx, handleToolbarAction]
  );

  // Handle approve action
  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;

    // Exit feedback mode if active
    feedbackContext?.exitFeedbackMode();

    try {
      await approveAsync({
        approvalId: pendingApproval.approvalId,
        executionProcessId: pendingApproval.executionProcessId,
      });

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch {
      // Error is handled by mutation
    }
  }, [
    pendingApproval,
    feedbackContext,
    approveAsync,
    queryClient,
    onScrollToBottom,
  ]);

  // Handle request changes (deny with feedback)
  const handleRequestChanges = useCallback(async () => {
    if (!pendingApproval || !localMessage.trim()) return;

    try {
      await denyAsync({
        approvalId: pendingApproval.approvalId,
        executionProcessId: pendingApproval.executionProcessId,
        reason: localMessage.trim(),
      });
      cancelDebouncedSave();
      setLocalMessage('');
      await clearDraft();

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch {
      // Error is handled by mutation
    }
  }, [
    pendingApproval,
    localMessage,
    denyAsync,
    cancelDebouncedSave,
    setLocalMessage,
    clearDraft,
    queryClient,
    onScrollToBottom,
  ]);

  // Handle AskUserQuestion answer submission
  const handleAnswerQuestion = useCallback(
    async (answers: Array<{ question: string; answer: string[] }>) => {
      if (!pendingApproval) return;

      try {
        await answerAsync({
          approvalId: pendingApproval.approvalId,
          executionProcessId: pendingApproval.executionProcessId,
          answers,
        });
        queryClient.invalidateQueries({
          queryKey: workspaceSummaryKeys.all,
        });
        onScrollToBottom();
      } catch {
        // Error is handled by mutation
      }
    },
    [pendingApproval, answerAsync, queryClient, onScrollToBottom]
  );

  // Check if approval is timed out
  const isApprovalTimedOut = pendingApproval
    ? new Date() > new Date(pendingApproval.timeoutAt)
    : false;

  const status = computeExecutionStatus({
    isInFeedbackMode,
    isInEditMode,
    isStopping,
    isQueueLoading,
    isSendingFollowUp: isSending || steerMutation.isPending,
    isQueued,
    isAttemptRunning,
  });

  // During loading, render with empty editor to preserve container UI
  // In approval mode, don't show queued message - it's for follow-up, not approval response
  const editorValue = useMemo(() => {
    if (isScratchLoading || !hasInitialValue) return '';
    if (pendingApproval) return localMessage;
    return queuedMessage ?? localMessage;
  }, [
    isScratchLoading,
    hasInitialValue,
    pendingApproval,
    queuedMessage,
    localMessage,
  ]);

  const renderEditor = useCallback(
    ({
      focusKey,
      placeholder,
      value,
      onChange,
      onCmdEnter,
      disabled,
      repoIds,
      executor,
      onPasteFiles,
      localAttachments,
    }: SessionChatBoxEditorRenderProps<BaseCodingAgent>) => (
      <WYSIWYGEditor
        key={focusKey}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onCmdEnter={onCmdEnter}
        disabled={disabled}
        className="min-h-double max-h-[50vh] overflow-y-auto"
        repoIds={repoIds}
        executor={executor}
        sessionId={sessionId}
        autoFocus
        onPasteFiles={onPasteFiles}
        localAttachments={localAttachments}
        sendShortcut={config?.send_message_shortcut}
      />
    ),
    [config?.send_message_shortcut, sessionId]
  );

  const modelSelectorNode = effectiveExecutor ? (
    <ModelSelectorContainer
      agent={effectiveExecutor}
      workspaceId={workspaceId}
      sessionId={sessionId}
      onAdvancedSettings={handleCustomise}
      presets={variantOptions}
      selectedPreset={selectedVariant}
      onPresetSelect={setSelectedVariant}
      onOverrideChange={setExecutorOverrides}
      executorConfig={executorConfig}
      presetOptions={presetOptions}
    />
  ) : undefined;

  // In placeholder mode, render a disabled version to maintain visual structure
  if (mode === 'placeholder') {
    return (
      <SessionChatBox<BaseCodingAgent>
        status="idle"
        renderEditor={renderEditor}
        repoIds={repoIds}
        tokenUsageInfo={tokenUsageInfo}
        supportsContextUsage={false}
        formatExecutorLabel={toPrettyCase}
        formatSessionDate={(createdAt) =>
          formatDateShortWithTime(
            createdAt instanceof Date ? createdAt.toISOString() : createdAt
          )
        }
        renderAgentIcon={(executor, className) => (
          <AgentIcon
            agent={executor as BaseCodingAgent | null | undefined}
            className={className}
          />
        )}
        editor={{
          value: '',
          onChange: () => {},
        }}
        actions={{
          onSend: () => {},
          onSteer: () => {},
          onQueue: () => {},
          onCancelQueue: () => {},
          onStop: () => {},
          onPasteFiles: () => {},
        }}
        session={{
          sessions: [],
          selectedSessionId: undefined,
          onSelectSession: () => {},
          isNewSessionMode: false,
          onNewSession: undefined,
        }}
        stats={{
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        }}
        onViewCode={disableViewCode ? undefined : handleViewCode}
      />
    );
  }

  return (
    <SessionChatBox<BaseCodingAgent>
      status={status}
      onViewCode={disableViewCode ? undefined : handleViewCode}
      onOpenWorkspace={
        showOpenWorkspaceButton && workspaceId ? handleOpenWorkspace : undefined
      }
      onScrollToPreviousMessage={onScrollToPreviousMessage}
      userMessageTurns={userMessageTurns}
      onScrollToUserMessage={onScrollToUserMessage}
      getActiveTurnPatchKey={getActiveTurnPatchKey}
      renderEditor={renderEditor}
      repoIds={repoIds}
      tokenUsageInfo={tokenUsageInfo}
      supportsContextUsage={supportsContextUsage}
      formatExecutorLabel={toPrettyCase}
      formatSessionDate={(createdAt) =>
        formatDateShortWithTime(
          createdAt instanceof Date ? createdAt.toISOString() : createdAt
        )
      }
      renderAgentIcon={(executor, className) => (
        <AgentIcon
          agent={executor as BaseCodingAgent | null | undefined}
          className={className}
        />
      )}
      editor={{
        value: editorValue,
        onChange: handleEditorChange,
      }}
      actions={{
        onSend: handleSend,
        onSteer: handleSteer,
        onQueue: handleQueueMessage,
        onCancelQueue: handleCancelQueue,
        onStop: stopExecution,
        onPasteFiles: uploadFiles,
      }}
      session={{
        sessions,
        selectedSessionId: sessionId,
        onSelectSession: onSelectSession ?? (() => {}),
        isNewSessionMode: needsExecutorSelection,
        onNewSession: onStartNewSession,
        onMigrateToNewSession:
          mode === 'existing-session' ? handleMigrateToNewSession : undefined,
        onRenameSession: handleRenameSession,
      }}
      toolbarActions={{
        items: toolbarActionItems,
      }}
      migrationMode={{
        isActive: isMigrationMode,
        notice: migrationNotice,
      }}
      onPrCommentClick={
        actionCtx.hasOpenPR ? handleInsertPrComments : undefined
      }
      stats={{
        filesChanged,
        linesAdded,
        linesRemoved,
        hasConflicts,
        conflictedFilesCount,
        onResolveConflicts: handleResolveConflicts,
      }}
      error={sendError ?? steerError}
      canSteer={canSteerRunningAgent}
      agent={effectiveExecutor}
      todos={todos}
      inProgressTodo={inProgressTodo}
      executor={
        effectiveExecutor
          ? {
              selected: effectiveExecutor,
              options: executorOptions,
              onChange: handleExecutorChange,
            }
          : undefined
      }
      feedbackMode={
        feedbackContext
          ? {
              isActive: isInFeedbackMode,
              onSubmitFeedback: handleSubmitFeedback,
              onCancel: handleCancelFeedback,
              isSubmitting: feedbackContext.isSubmitting,
              error: feedbackContext.error,
              isTimedOut: feedbackContext.isTimedOut,
            }
          : undefined
      }
      approvalMode={
        pendingApproval && !pendingApproval.questions
          ? {
              isActive: true,
              onApprove: handleApprove,
              onRequestChanges: handleRequestChanges,
              isSubmitting: isApproving || isDenying,
              isTimedOut: isApprovalTimedOut,
              error: denyError?.message ?? null,
            }
          : undefined
      }
      askQuestionMode={
        pendingApproval?.questions
          ? {
              isActive: true,
              questions: pendingApproval.questions,
              onSubmitAnswers: handleAnswerQuestion,
              isSubmitting: isAnswering,
              isTimedOut: isApprovalTimedOut,
              error: answerError?.message ?? null,
            }
          : undefined
      }
      editMode={{
        isActive: isInEditMode,
        onSubmitEdit: handleSubmitEdit,
        onCancel: handleCancelEdit,
        isSubmitting: editRetryMutation.isPending,
      }}
      reviewComments={
        hasReviewComments && reviewContext
          ? {
              count: reviewContext.comments.length,
              previewMarkdown: reviewMarkdown,
              onClear: reviewContext.clearComments,
            }
          : undefined
      }
      localAttachments={localAttachments}
      dropzone={{ getRootProps, getInputProps, isDragActive }}
      modelSelector={modelSelectorNode}
    />
  );
}
