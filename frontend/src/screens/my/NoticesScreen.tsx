import React from 'react';
import EmptyState from '../../components/states/EmptyState';
export default function NoticesScreen() {
  return (
    <EmptyState
      title="등록된 공지사항이 없습니다."
      message="새로운 공지사항이 등록되면 이곳에서 확인할 수 있습니다."
    />
  );
}
