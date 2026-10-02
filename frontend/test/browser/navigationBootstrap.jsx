import React from 'react';
// Authentication is the fixture boundary; every navigator and screen after
// MainTabs is production code, including the root history route and headers.
export default function Bootstrap({ navigation }) {
  React.useEffect(() => { navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] }); }, [navigation]);
  return null;
}
