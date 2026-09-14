import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe } from '../../features/me/api';
import { shouldShowAdminDiagnostic } from '../../features/auth/adminDiagnostics';
import type { AdminDiagnosticDto } from '../../models/dto/common';
import { getApiErrorDiagnostic } from '../../services/api/errorMapper';

type Props = {
  diagnostic?: AdminDiagnosticDto | null;
  error?: unknown;
};

export default function AdminDiagnosticPanel({ diagnostic, error }: Props) {
  const [expanded, setExpanded] = useState(false);
  const resolved = diagnostic ?? getApiErrorDiagnostic(error);
  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
    enabled: Boolean(resolved),
  });
  const serializedEvidence = useMemo(
    () => formatJson(resolved?.evidence),
    [resolved?.evidence],
  );
  const serializedEntities = useMemo(
    () => formatJson(resolved?.entities),
    [resolved?.entities],
  );

  // The backend is the security boundary and never emits this payload to a
  // non-admin. The current /me role is checked as a second UI guard so a stale
  // or manually injected client object still does not create an admin panel.
  if (!shouldShowAdminDiagnostic(meQuery.data?.role, resolved)) return null;

  return (
    <View style={styles.container} testID="admin-diagnostic-panel">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.toggle}
        testID="admin-diagnostic-toggle"
      >
        <Text style={styles.toggleText}>
          관리자 상세 진단 {expanded ? '▲' : '▼'}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={styles.content} testID="admin-diagnostic-content">
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

          <Section title="관련 Server Logs">
            <CodeText>
              {resolved.serverLogs.events
                .map(
                  (entry) =>
                    `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.event}\n${entry.message}${entry.context ? `\n${formatJson(entry.context)}` : ''}`,
                )
                .join('\n\n') || '(related logs unavailable)'}
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
          resolved.serverLogs.truncated ||
          resolved.exception.truncated ? (
            <Text style={styles.truncated}>
              진단 정보가 길어 일부만 표시되었습니다.
            </Text>
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
      <Text selectable style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

function CodeText({ children }: React.PropsWithChildren) {
  return (
    <Text selectable style={styles.code}>
      {children}
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

const styles = StyleSheet.create({
  container: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#9a6700',
    borderRadius: 10,
    backgroundColor: '#fff8c5',
    overflow: 'hidden',
  },
  toggle: { paddingHorizontal: 12, paddingVertical: 11 },
  toggleText: { color: '#6f4b00', fontSize: 14, fontWeight: '700' },
  content: {
    borderTopWidth: 1,
    borderTopColor: '#d4a72c',
    padding: 12,
    gap: 14,
  },
  section: { gap: 6, minWidth: 0 },
  sectionTitle: { color: '#4d2d00', fontWeight: '700', fontSize: 13 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minWidth: 0 },
  label: { width: 92, flexShrink: 0, color: '#6f4b00', fontSize: 12 },
  value: {
    flex: 1,
    flexShrink: 1,
    color: '#24292f',
    fontSize: 12,
    lineHeight: 18,
  },
  code: {
    flexShrink: 1,
    color: '#24292f',
    backgroundColor: '#fff',
    borderRadius: 6,
    padding: 8,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
  },
  truncated: { color: '#9a6700', fontSize: 12, lineHeight: 18 },
});
