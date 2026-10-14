import React, { useState } from 'react';
import { StyleSheet, Text as ThemedText, useWindowDimensions } from '../../theme/native';
import { joinFigures, type TextLine } from './figureText';

/**
 * The guides' Text: the shared themed Text whose figures keep their units on
 * one line (figureText). Prose still wraps freely, and text without figures
 * renders exactly as before. A Text with figures measures its own width, so a
 * figure wider than the whole line (very large text on a narrow screen) wraps
 * at a readable place.
 */
export function Text({ children, style, onLayout, ...props }: React.ComponentProps<typeof ThemedText>) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState<number | null>(null);
  const { fontSize = 14, fontWeight } = StyleSheet.flatten(style) ?? {};
  const line = width === null ? undefined
    : { width, fontSize: fontSize * fontScale, bold: fontWeight === 'bold' || Number(fontWeight) >= 600 };
  const { content, figures } = joinChildren(children, line);
  return (
    <ThemedText {...props} style={style}
      onLayout={figures ? (event) => { setWidth(event.nativeEvent.layout.width); onLayout?.(event); } : onLayout}>
      {content}
    </ThemedText>
  );
}

// Adjacent strings and numbers render as one run (`{quantity}주`), so they are
// joined before figures are found. Elements (a nested Text) stay as they are.
function joinChildren(children: React.ReactNode, line: TextLine | undefined) {
  const parts: React.ReactNode[] = [];
  let run: string | null = null;
  let figures = false;
  const flush = () => {
    if (run === null) return;
    figures ||= /\d/.test(run);
    parts.push(joinFigures(run, line));
    run = null;
  };
  const visit = (node: React.ReactNode) => {
    if (typeof node === 'string' || typeof node === 'number') {
      run = (run ?? '') + node;
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && node !== undefined && typeof node !== 'boolean') {
      flush();
      parts.push(node);
    }
  };
  visit(children);
  flush();
  const content = parts.length <= 1 ? parts[0] ?? children : React.createElement(React.Fragment, null, ...parts);
  return { content, figures };
}
