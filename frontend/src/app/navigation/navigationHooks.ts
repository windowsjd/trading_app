import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type {
  RootStackParamList,
  AuthStackParamList,
  MyStackParamList,
  CommunityPostRoutes,
} from './types';

export function useRootNavigation() {
  return useNavigation<NativeStackNavigationProp<RootStackParamList>>();
}

export function useAuthNavigation() {
  return useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
}

export function useMyNavigation() {
  return useNavigation<NativeStackNavigationProp<MyStackParamList>>();
}

/** The post routes (글 상세, 글쓰기, 유저 시즌 요약) of whichever community stack the screen is in. */
export function useCommunityNavigation() {
  return useNavigation<NativeStackNavigationProp<CommunityPostRoutes>>();
}
