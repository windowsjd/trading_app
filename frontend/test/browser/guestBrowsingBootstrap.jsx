import React from 'react';
// A cold start with no stored token: the production Login screen is the entry.
export default function Bootstrap({ navigation }) {
  React.useEffect(() => { navigation.reset({ index: 0, routes: [{ name: 'AuthStack', params: { screen: 'Login' } }] }); }, [navigation]);
  return null;
}
