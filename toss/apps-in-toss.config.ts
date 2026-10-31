import { defineConfig } from '@apps-in-toss/web-framework/config';

// appName은 앱인토스 콘솔에 등록한 이름과 같아야 업로드돼요. 콘솔 등록 뒤 바꿔 주세요.
export default defineConfig({
  appName: 'splash-man',
  brand: {
    primaryColor: '#8FF0D6',
  },
  navigationBar: {
    withBackButton: true,
    withHomeButton: true,
    withTitle: true,
    theme: 'dark',
  },
  webView: {
    bounces: false,
    pullToRefreshEnabled: false,
    overScrollMode: 'never',
    allowsInlineMediaPlayback: true,
    mediaPlaybackRequiresUserAction: false,
    allowsBackForwardNavigationGestures: false,
  },
  permissions: [],
  webBundleDir: 'dist',
});
