import React, { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { GuideStackParamList } from '../../app/navigation/types';
import { LessonAction, LessonPage, Section } from './LessonUi';
import { Basis } from './MarketLessonUi';
import {
  AuctionsLesson,
  GapsLesson,
  SafeguardsLesson,
  SessionsLesson,
} from './StockLessons';
import {
  AdjustedLesson,
  DividendsLesson,
  SplitsLesson,
} from './CorporateLessons';
import { IndexLesson, NavLesson, TrackingLesson } from './EtfLessons';
import { chapterTitle, type GuideChapter } from './guideTopics';
import { VERIFIED_ON } from './marketLessonData';

const lessons = {
  sessions: SessionsLesson,
  auctions: AuctionsLesson,
  gaps: GapsLesson,
  safeguards: SafeguardsLesson,
  splits: SplitsLesson,
  dividends: DividendsLesson,
  adjusted: AdjustedLesson,
  index: IndexLesson,
  nav: NavLesson,
  tracking: TrackingLesson,
} satisfies Record<GuideChapter, React.ComponentType>;
const sources: Record<GuideChapter, string> = {
  sessions:
    'KRX 거래시간·시간외 거래, NXT 시장 개요, NYSE 거래일정, NIST 서머타임',
  auctions: 'KRX 매매체결·시간외 거래, SEC 장전·장후 거래',
  gaps: 'KRX 거래시간·기준가격, NXT 시장 개요',
  safeguards: 'KRX 변동성 완화장치·가격제한폭',
  splits: 'SEC 주식병합, KRX 기준가격, TradingView 주식분할',
  dividends: 'SEC 배당락일, KRX 기준가격',
  adjusted: 'TradingView 분할·배당 조정, KRX 기준가격',
  index: 'SEC 지수펀드·ETF',
  nav: 'SEC ETF, KRX ETF 교육자료',
  tracking: 'Vanguard 지수 추종, SEC ETF·지수펀드',
};
export default function GuideChapterScreen({
  route,
}: NativeStackScreenProps<GuideStackParamList, 'GuideChapter'>) {
  const [attempt, setAttempt] = useState(0);
  const chapter = route.params.chapter;
  const Lesson = lessons[chapter];
  // A new keyed page clears all local inputs/results and returns the scroll to its start.
  // Exercises advance on explicit actions: no playback timers or delayed measurements.
  return (
    <LessonPage key={`${chapter}-${attempt}`} id={`guide-lesson-${chapter}`}>
      <Section title={chapterTitle(chapter)} introduction>
        <Lesson />
      </Section>
      <Basis>
        자료 기준: {sources[chapter]} · 확인 {VERIFIED_ON}
      </Basis>
      <LessonAction
        id={`reset-${chapter}`}
        label="처음부터 다시 보기"
        secondary
        onPress={() => setAttempt((value) => value + 1)}
      />
    </LessonPage>
  );
}
