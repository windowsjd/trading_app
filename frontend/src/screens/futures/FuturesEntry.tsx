import React from 'react';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import CTAButton from '../../components/common/CTAButton';
export default function FuturesEntry({ accountId }: { accountId: string }) {
  const navigation = useRootNavigation();
  return <CTAButton variant="secondary" label="암호화폐 선물 · 포지션과 거래" onPress={() => navigation.navigate('MainTabs', {
    screen: 'HomeTab', params: { screen: 'Futures', params: { accountId } },
  })} />;
}
