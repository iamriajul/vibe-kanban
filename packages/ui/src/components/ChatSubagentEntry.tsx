import type { KeyboardEvent, ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDownIcon,
  CpuIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
} from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import type { ToolStatusLike } from './ToolStatusDot';

export interface ChatSubagentResultLike {
  value?: unknown | null;
}

export interface ChatSubagentEntryRenderProps {
  content: string;
  workspaceId?: string;
}

export interface ChatSubagentDetails {
  model?: string | null;
  effort?: string | null;
  prompt?: string | null;
}

interface ChatSubagentEntryProps {
  description: string;
  subagentType?: string | null;
  details?: ChatSubagentDetails | null;
  result?: ChatSubagentResultLike | null;
  fallbackContent?: string | null;
  expanded?: boolean;
  onToggle?: () => void;
  className?: string;
  status?: ToolStatusLike;
  workspaceId?: string;
  renderMarkdown: (props: ChatSubagentEntryRenderProps) => ReactNode;
}

/**
 * Renders a collapsible subagent (Task tool) entry showing:
 * - Header with subagent type and description
 * - Expandable content showing the subagent's output/conversation
 */
export function ChatSubagentEntry({
  description,
  subagentType,
  details,
  result,
  fallbackContent,
  expanded = false,
  onToggle,
  className,
  status,
  workspaceId,
  renderMarkdown,
}: ChatSubagentEntryProps) {
  const { t } = useTranslation('common');

  // Determine status icon - consistent with ToolStatusDot
  const StatusIcon = useMemo(() => {
    if (!status) return null;
    const statusType = status.status;

    // Map status to visual state (consistent with ToolStatusDot)
    const isSuccess = statusType === 'success';
    const isError =
      statusType === 'failed' ||
      statusType === 'denied' ||
      statusType === 'timed_out';
    const isPending =
      statusType === 'created' || statusType === 'pending_approval';

    if (isSuccess) {
      return (
        <CheckCircleIcon className="size-icon-xs text-success" weight="fill" />
      );
    }
    if (isError) {
      return <XCircleIcon className="size-icon-xs text-error" weight="fill" />;
    }
    if (isPending) {
      return <CircleNotchIcon className="size-icon-xs text-low animate-spin" />;
    }
    return null;
  }, [status]);

  // Determine if status is an error state (for styling)
  const isErrorStatus = useMemo(() => {
    if (!status) return false;
    return (
      status.status === 'failed' ||
      status.status === 'denied' ||
      status.status === 'timed_out'
    );
  }, [status]);

  // Format the subagent type for display
  const formattedType = useMemo(() => {
    if (!subagentType) return t('conversation.subagent.defaultType');
    // Capitalize first letter and format
    return subagentType.charAt(0).toUpperCase() + subagentType.slice(1);
  }, [subagentType, t]);

  // Extract the result content for display
  const resultContent = useMemo(() => {
    if (result?.value == null) {
      const fallback = fallbackContent?.trim();
      return fallback || null;
    }

    // Handle both string and object values
    if (typeof result.value === 'string') {
      return result.value;
    }

    // For JSON results, stringify with formatting
    return JSON.stringify(result.value, null, 2);
  }, [result, fallbackContent]);

  const detailRows = useMemo(
    () =>
      [
        { label: t('conversation.subagent.model'), value: details?.model },
        { label: t('conversation.subagent.effort'), value: details?.effort },
      ].filter(
        (row): row is { label: string; value: string } =>
          typeof row.value === 'string' && row.value.trim().length > 0
      ),
    [details?.effort, details?.model, t]
  );
  const prompt = details?.prompt?.trim() || null;
  const hasDetails = detailRows.length > 0 || Boolean(prompt);

  // Determine if we have content to show
  const hasContent = Boolean(resultContent);
  const isInteractive = Boolean(onToggle && (hasContent || hasDetails));
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive || event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle?.();
  };

  return (
    <div
      className={cn(
        'rounded-sm border overflow-hidden',
        isErrorStatus && 'border-error bg-error/5',
        status?.status === 'success' && 'border-success/50',
        !isErrorStatus && status?.status !== 'success' && 'border-border',
        className
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center px-double py-base gap-base',
          isErrorStatus && 'bg-error/10',
          status?.status === 'success' && 'bg-success/5',
          isInteractive && 'cursor-pointer'
        )}
        onClick={isInteractive ? onToggle : undefined}
        onKeyDown={handleKeyDown}
        role={isInteractive ? 'button' : undefined}
        aria-expanded={isInteractive ? expanded : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        data-scroll-anchor-target={isInteractive ? '' : undefined}
      >
        <span className="relative shrink-0">
          <CpuIcon className="size-icon-base text-low" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-base">
            <span className="text-xs font-medium text-low uppercase tracking-wide">
              {formattedType}
            </span>
            {StatusIcon}
          </div>
          <span className="text-sm text-normal truncate block">
            {description}
          </span>
        </div>
        {isInteractive && (
          <CaretDownIcon
            className={cn(
              'size-icon-xs shrink-0 text-low transition-transform',
              !expanded && '-rotate-90'
            )}
          />
        )}
      </div>

      {/* Expanded content - shows subagent launch details and output */}
      {expanded && (hasDetails || hasContent) && (
        <div className="border-t p-double bg-panel/50 space-y-double">
          {hasDetails && (
            <div className="space-y-base">
              {detailRows.length > 0 && (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-double gap-y-small text-xs">
                  {detailRows.map((row) => (
                    <div key={row.label} className="contents">
                      <dt className="text-low">{row.label}</dt>
                      <dd className="text-normal break-words">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {prompt && (
                <div className="space-y-small">
                  <div className="text-xs font-medium text-low uppercase tracking-wide">
                    {t('conversation.subagent.prompt')}
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded-sm border bg-background/50 p-base text-xs text-normal font-mono">
                    {prompt}
                  </pre>
                </div>
              )}
            </div>
          )}
          {hasContent && (
            <div>
              <div className="text-xs font-medium text-low pb-base uppercase tracking-wide">
                {t('conversation.output')}
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                {renderMarkdown({ content: resultContent!, workspaceId })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
