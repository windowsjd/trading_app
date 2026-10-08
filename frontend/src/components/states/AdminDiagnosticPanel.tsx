import { semantic } from '../../theme/tokens';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from '../../theme/native';
import ActionPressable from '../common/ActionPressable';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../../features/me/api';
import { shouldShowAdminDiagnostic } from '../../features/auth/adminDiagnostics';
import type { AdminDiagnosticDto } from '../../models/dto/common';
import { getApiErrorDiagnostic, sanitizeAdminDiagnostic } from '../../services/api/errorMapper';
import type { RuntimeFacts } from '../../services/ws/runtimeDiagnostics';

type Props = {
  diagnostic?: AdminDiagnosticDto | null;
  error?: unknown;
  /** Observed client state only; never represents a backend failure. */
  runtime?: RuntimeFacts | null;
  /** Request facts may accompany a server diagnostic; socket facts retain
   * their existing standalone presentation by default. */
  includeRuntimeWithDiagnostic?: boolean;
};

export default function AdminDiagnosticPanel({
  diagnostic,
  error,
  runtime,
  includeRuntimeWithDiagnostic = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const resolved = useMemo(() => diagnostic ? sanitizeAdminDiagnostic(diagnostic) : getApiErrorDiagnostic(error), [diagnostic, error]);
  const runtimeFacts =
    (!resolved || includeRuntimeWithDiagnostic) && runtime
      ? Object.fromEntries(
          Object.entries(runtime).filter(
            ([, value]) => value !== undefined && value !== null,
          ),
        )
      : null;
  const hasRuntimeFacts =
    !!runtimeFacts && Object.keys(runtimeFacts).length > 0;
  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
    enabled: Boolean(resolved) || hasRuntimeFacts,
  });
  const serializedEvidence = useMemo(
    () => formatJson(resolved?.evidence),
    [resolved?.evidence],
  );
  const serializedEntities = useMemo(
    () => formatJson(resolved?.entities),
    [resolved?.entities],
  );

  // The backend emits its diagnostic only for the current DB admin role.
  // /me also guards both backend payloads and observed client runtime facts.
  if (
    meQuery.isError ||
    (!shouldShowAdminDiagnostic(meQuery.data?.role, resolved) &&
      !(meQuery.data?.role === 'admin' && hasRuntimeFacts))
  )
    return null;

  return (
    <View style={styles.container} testID="admin-diagnostic-panel">
      <ActionPressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.toggle}
        testID="admin-diagnostic-toggle"
      >
        <Text style={styles.toggleText}>
          관리자 상세 진단 {expanded ? '▲' : '▼'}
        </Text>
      </ActionPressable>

      {expanded ? (
        <View style={styles.content} testID="admin-diagnostic-content">
          {resolved ? (
            <>
              <Section title="오류 정보">
                <Line label="Code" value={resolved.code} />
                <Line label="HTTP" value={String(resolved.httpStatus)} />
                <Line label="Domain" value={resolved.domain} />
                <Line label="Operation" value={resolved.operation} />
                <Line label="Failure stage" value={resolved.failureStage} />
                <Line label="Timestamp" value={resolved.timestamp} />
                <Line label="Request ID" value={resolved.requestId} />
              </Section>

              {serializedEntities ? (
                <Section title="관련 식별자">
                  <CodeText>{serializedEntities}</CodeText>
                </Section>
              ) : null}

              {serializedEvidence ? (
                <Section title="판단 근거">
                  <CodeText>{serializedEvidence}</CodeText>
                </Section>
              ) : null}

              <Section title="Backend Exception">
                <Line label="Type" value={resolved.exception.type} />
                <Line label="Message" value={resolved.exception.message} />
                {resolved.exception.cause ? (
                  <Line label="Cause" value={resolved.exception.cause} />
                ) : null}
              </Section>

              <Section title="Application Stack">
                <CodeText>
                  {(resolved.exception.applicationStack.length
                    ? resolved.exception.applicationStack
                    : resolved.exception.stack
                  ).join('\n') || '(stack unavailable)'}
                </CodeText>
              </Section>

              <Section title="진단 이벤트">
                <CodeText>
                  {resolved.diagnosticEvents.events
                    .map(
                      (entry) =>
                        `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.event}\n${entry.message}${entry.context ? `\n${formatJson(entry.context)}` : ''}`,
                    )
                    .join('\n\n') || '(diagnostic events unavailable)'}
                </CodeText>
              </Section>

              <Section title="관련 Server Logs">
                <CodeText>
                  {resolved.serverLogs.entries
                    .map(
                      (entry) =>
                        `${entry.timestamp} ${entry.level.toUpperCase()}${entry.context ? ` [${entry.context}]` : ''}\n${entry.message}${entry.details?.length ? `\n${formatJson(entry.details)}` : ''}`,
                    )
                    .join('\n\n') || '(related application logs unavailable)'}
                </CodeText>
              </Section>

              {resolved.nextInvestigation?.length ? (
                <Section title="다음 조사 위치">
                  {resolved.nextInvestigation.map((hint) => (
                    <CodeText key={hint}>{hint}</CodeText>
                  ))}
                </Section>
              ) : null}

              {resolved.truncated ||
              resolved.diagnosticEvents.truncated ||
              resolved.serverLogs.truncated ||
              resolved.exception.truncated ? (
                <Text style={styles.truncated}>
                  진단 정보가 길어 일부만 표시되었습니다.
                </Text>
              ) : null}
            </>
          ) : null}
          {hasRuntimeFacts ? (
            <Section title="Client runtime 상태">
              {Object.entries(runtimeFacts ?? {}).map(([label, value]) => (
                <View key={label} style={styles.section}>
                  <Text accessibilityLabel={label} style={styles.runtimeLabel}>{wrapRuntimeText(label)}</Text>
                  <CodeText>{String(value)}</CodeText>
                </View>
              ))}
            </Section>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Section({
  title,
  children,
}: React.PropsWithChildren<{ title: string }>) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.label}>{label}</Text>
      <Text selectable accessibilityLabel={value} style={styles.value}>
        {wrapRuntimeText(value)}
      </Text>
    </View>
  );
}

function CodeText({ children, accessibilityLabel }: React.PropsWithChildren<{ accessibilityLabel?: string }>) {
  return (
    <Text selectable accessibilityLabel={accessibilityLabel ?? (typeof children === 'string' ? children : undefined)} style={styles.code}>
      {typeof children === 'string' ? wrapRuntimeText(children) : children}
    </Text>
  );
}

function formatJson(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) {
    return null;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[표시할 수 없는 진단 값]';
  }
}

// Native and Web both need break opportunities for protocol identifiers and
// ISO times at large font scales. Evidence values remain unchanged in memory.
function wrapRuntimeText(value: string): string {
  return value.replace(/(.{6})/gu, '$1\u200b');
}

const styles = StyleSheet.create({
  container: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: semantic.warning,
    borderRadius: 10,
    backgroundColor: semantic.warningSurface,
    alignSelf: 'stretch',
    maxWidth: '100%',
    minWidth: 0,
  },
  toggle: { paddingHorizontal: 12, paddingVertical: 11 },
  toggleText: { color: semantic.warning, fontSize: 14, fontWeight: '700' },
  content: {
    borderTopWidth: 1,
    borderTopColor: semantic.border,
    padding: 12,
    gap: 14,
  },
  section: { gap: 6, minWidth: 0 },
  sectionTitle: { color: semantic.warning, fontWeight: '700', fontSize: 13 },
  runtimeLabel: { minWidth: 0, flexShrink: 1, color: semantic.warning, fontSize: 12 },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 8,
    minWidth: 0,
  },
  label: { width: 92, flexShrink: 1, color: semantic.warning, fontSize: 12 },
  value: {
    flex: 1,
    flexShrink: 1,
    color: semantic.text,
    fontSize: 12,
    lineHeight: 18,
  },
  code: {
    minWidth: 0,
    flexShrink: 1,
    maxWidth: '100%',
    color: semantic.text,
    backgroundColor: semantic.raised,
    borderRadius: 6,
    padding: 8,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
  },
  truncated: { color: semantic.warning, fontSize: 12, lineHeight: 18 },
});
