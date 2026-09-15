import React, { Component, type ErrorInfo, type PropsWithChildren } from 'react';

import ErrorState from './ErrorState';

/** Last resort for render failures. API errors stay in each screen's ErrorState. */
export default class ScreenErrorBoundary extends Component<
  PropsWithChildren,
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
        />
      );
    }

    return this.props.children;
  }
}
