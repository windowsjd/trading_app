import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type {
  RootStackParamList,
  AuthStackParamList,
  MyStackParamList,
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