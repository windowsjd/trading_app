import React, { Component, type ErrorInfo, type PropsWithChildren } from 'react';

import { Text } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import ActionPressable from '../common/ActionPressable';
import ErrorState from './ErrorState';

/** The stack a failed screen sits in: the way back to the screen before it. */
export type ErrorBack = { canGoBack: () => boolean; goBack: () => void };

/** Last resort for render failures. API errors stay in each screen's ErrorState. */
export default class ScreenErrorBoundary extends Component<
  PropsWithChildren<{ back?: ErrorBack }>,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen render failed', error, info.componentStack);
  }

  private retry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorState
          title="화면을 표시하지 못했습니다."
          message="화면을 다시 열어주세요. 문제가 계속되면 앱을 다시 실행해주세요."
          actionLabel="화면 다시 열기"
          onRetry={this.retry}
        >
          {this.props.back?.canGoBack() ? (
            <ActionPressable testID="screen-error-back" accessibilityRole="button" feedback="button"
              style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }} onPress={() => this.props.back?.goBack()}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: semantic.secondaryActionForeground }}>이전 화면으로</Text>
            </ActionPressable>
          ) : null}
        </ErrorState>
      );
    }

    return this.props.children;
  }
}
