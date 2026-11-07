// The community screens over a small in-memory community server: the real
// API module (its response checks included), the real query cache, the real
// screens, cache helpers and write gate. Only the transport, navigation,
// sheets' animation hosts and native hosts are stand-ins. The server follows
// backend/docs/community-api-contract.md for what the app reads: visible
// posts only, HOT = 24 h + score ≥ 3 (others' likes + 2 × others' comments),
// rules/restriction 403s, idempotent writes and the like PUT/DELETE answers.
const { resolve } = require('node:path');
const query = require('@tanstack/react-query');
const { interactionHarness, React, act, flatten } = require('./interactionTestHarness.cjs');
const { load } = require('./ledgerTestHarness.cjs');

const errorMapper = require(resolve(__dirname, '../src/services/api/errorMapper.ts'));
const { getFinancialColors } = require(resolve(__dirname, '../src/theme/financialColors.ts'));
const { PALETTES } = load(resolve(__dirname, '../src/theme/appearance.tsx'), {
  'react-native': { Appearance: {}, Platform: { OS: 'android' }, StatusBar: 'StatusBar', useColorScheme: () => 'light', View: 'View' },
  '@react-native-async-storage/async-storage': { __esModule: true, default: {} },
});

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const RULES = [
  { code: 'AD_SPAM', label: '광고·도배', description: '같은 글을 반복하거나 홍보하는 글', noteRequired: false },
  { code: 'ABUSE', label: '욕설·비하', description: '다른 회원을 공격하는 글', noteRequired: false },
];

const httpError = (status, code) => Object.assign(new Error(code), {
  isAxiosError: true, request: {}, response: { status, data: { success: false, error: { code, message: code } } },
});
const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} });
const deferred = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };

function communityServer() {
  const server = {
    now: NOW,
    viewer: 'me',
    users: {
      me: { userId: 'me', nickname: 'demiant', profileImageUrl: null, tier: 'master', role: 'user' },
      u2: { userId: 'u2', nickname: 'bluechip', profileImageUrl: null, tier: 'gold', role: 'user' },
      u3: { userId: 'u3', nickname: 'value-lab', profileImageUrl: null, tier: null, role: 'user' },
    },
    rulesAccepted: true,
    sanction: null,
    posts: [],
    comments: [],
    requests: [],
    // [{ method, path (prefix), error }] — the first match is thrown once.
    failures: [],
    // [{ method, path (prefix), gate }] — the first match waits for its gate once.
    holds: [],
    // [{ method, path (prefix) }] — the first match is processed, then its answer is lost (no response).
    lostAnswers: [],
    receipts: new Map(),
    seq: 0,
    meFailures: [],
  };
  const iso = (time) => new Date(time).toISOString();
  const visible = (item) => !item.deleted;
  const others = (post, ids) => [...ids].filter((id) => id !== post.userId);
  const visibleComments = (post) => server.comments.filter((comment) => comment.postId === post.id && visible(comment));
  const score = (post) => others(post, post.likes).length + 2 * visibleComments(post).filter((comment) => comment.userId !== post.userId).length;
  const isHot = (post) => post.createdAt > server.now - 24 * HOUR && score(post) >= 3;
  const publicAuthor = (userId) => {
    const user = server.users[userId];
    return { kind: 'public', userId, nickname: user.nickname, profileImageUrl: user.profileImageUrl, tier: user.tier };
  };
  server.postView = (post) => ({
    id: post.id, category: post.category, body: post.body, createdAt: iso(post.createdAt),
    author: post.anonymous ? { kind: 'anonymous', label: '익명' } : publicAuthor(post.userId),
    asset: null, photos: post.photos, likeCount: post.likes.size, commentCount: visibleComments(post).length,
    likedByMe: post.likes.has(server.viewer), mine: post.userId === server.viewer, isHot: isHot(post),
  });
  const commentView = (comment) => {
    const post = server.posts.find((item) => item.id === comment.postId);
    const base = { id: comment.id, postId: comment.postId, parentCommentId: comment.parentCommentId, createdAt: iso(comment.createdAt),
      likeCount: comment.likes.size, likedByMe: comment.likes.has(server.viewer), mine: comment.userId === server.viewer };
    if (comment.deleted) return { ...base, deleted: true, body: null, author: null };
    const postAuthor = post.anonymous && comment.userId === post.userId;
    const author = comment.anonymous
      ? { kind: 'anonymous', label: postAuthor ? '익명' : '익명1', isPostAuthor: postAuthor }
      : publicAuthor(comment.userId);
    return { ...base, deleted: false, body: comment.body, author };
  };

  /** A post as it is stored: `likes` and the author's id, never sent as such. */
  server.addPost = ({ id = `p${++server.seq}`, userId = 'u2', category = 'free', body = '본문', anonymous = false,
    ageMinutes = 5, likes = [], photos = [] } = {}) => {
    const post = { id, userId, category, body, anonymous, createdAt: server.now - ageMinutes * 60_000, likes: new Set(likes), photos, deleted: false };
    server.posts.push(post);
    return post;
  };
  server.addComment = ({ postId, userId = 'u3', body = '댓글', anonymous = false, parentCommentId = null, ageMinutes = 1 }) => {
    const comment = { id: `c${++server.seq}`, postId, userId, body, anonymous, parentCommentId,
      createdAt: server.now - ageMinutes * 60_000, likes: new Set(), deleted: false };
    server.comments.push(comment);
    return comment;
  };
  server.fail = (method, path, error) => { server.failures.push({ method, path, error }); };
  server.loseAnswer = (method, path) => { server.lostAnswers.push({ method, path }); };
  server.hold = (method, path) => { const gate = deferred(); server.holds.push({ method, path, gate }); return gate; };

  const paged = (all, path) => {
    const params = new URLSearchParams(path.split('?')[1]);
    const limit = Number(params.get('limit') ?? 20), offset = Number(params.get('offset') ?? 0);
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length < all.length ? offset + items.length : null;
    return { items, pagination: { limit, offset, total: all.length, returned: items.length, nextOffset: next } };
  };
  const byNewest = (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id);
  const writeGate = () => {
    if (!server.rulesAccepted) throw httpError(403, 'COMMUNITY_RULES_NOT_ACCEPTED');
    if (server.sanction) throw httpError(403, 'COMMUNITY_RESTRICTED');
  };
  const findPost = (id) => {
    const post = server.posts.find((item) => item.id === id && visible(item));
    if (!post) throw httpError(404, 'COMMUNITY_POST_NOT_FOUND');
    return post;
  };
  const ok = (data) => ({ data: { success: true, data } });

  async function respond(method, path, body) {
    server.requests.push({ method, path, body });
    const hold = server.holds.findIndex((item) => item.method === method && path.startsWith(item.path));
    if (hold >= 0) { const [{ gate }] = server.holds.splice(hold, 1); await gate.promise; }
    const failure = server.failures.findIndex((item) => item.method === method && path.startsWith(item.path));
    if (failure >= 0) { const [{ error }] = server.failures.splice(failure, 1); throw error; }
    const route = path.split('?')[0];
    if (method === 'get' && route === '/community/bootstrap') {
      return ok({ rulesVersion: 'v1', rulesAccepted: server.rulesAccepted, reasons: RULES, maxPhotos: 4, postBodyMaxLength: 500,
        commentBodyMaxLength: 300, me: publicAuthor(server.viewer), activeSanction: server.sanction });
    }
    if (method === 'get' && route === '/community/posts') {
      const category = new URLSearchParams(path.split('?')[1]).get('category');
      const live = server.posts.filter(visible);
      const all = category === 'hot'
        ? live.filter(isHot).sort((a, b) => score(b) - score(a) || byNewest(a, b)).slice(0, 30)
        : live.filter((post) => category === 'all' || post.category === category).sort(byNewest);
      const { items, pagination } = paged(all, path);
      return ok({ posts: items.map(server.postView), pagination });
    }
    let match = route.match(/^\/community\/posts\/([^/]+)$/);
    if (method === 'get' && match) return ok({ post: server.postView(findPost(match[1])) });
    match = route.match(/^\/community\/posts\/([^/]+)\/comments$/);
    if (method === 'get' && match) {
      const post = findPost(match[1]);
      const all = server.comments.filter((comment) => comment.postId === post.id);
      const top = all.filter((comment) => !comment.parentCommentId).sort(byNewest);
      const thread = top.flatMap((comment) => [comment, ...all.filter((reply) => reply.parentCommentId === comment.id)
        .sort((a, b) => a.createdAt - b.createdAt)]);
      const { items, pagination } = paged(thread, path);
      return ok({ comments: items.map(commentView), pagination });
    }
    if (method === 'post' && route === '/community/rules/consent') {
      server.rulesAccepted = true;
      return ok({ rulesVersion: body.rulesVersion, acceptedAt: iso(server.now) });
    }
    if (method === 'post' && route === '/community/posts') {
      const payload = JSON.parse(body.get('payload'));
      const photos = body.getAll('photos');
      const receipt = server.receipts.get(`post:${server.viewer}:${payload.clientRequestId}`);
      if (receipt) return ok({ post: server.postView(findPost(receipt)), replayed: true });
      const text = typeof payload.body === 'string' ? payload.body.trim() : '';
      if (![...text].length || [...text].length > 500) throw httpError(400, 'INVALID_COMMUNITY_POST');
      writeGate();
      const post = server.addPost({ userId: server.viewer, category: payload.category, body: text, anonymous: payload.anonymous, ageMinutes: 0,
        photos: photos.map((_, index) => ({ url: `https://cdn.example.com/community-images/new-${index}.jpg`, width: 1280, height: 960 })) });
      server.receipts.set(`post:${server.viewer}:${payload.clientRequestId}`, post.id);
      return ok({ post: server.postView(post), replayed: false });
    }
    match = route.match(/^\/community\/posts\/([^/]+)\/like$/);
    if (match) {
      const post = findPost(match[1]);
      if (method === 'put') {
        if (post.userId === server.viewer) throw httpError(409, 'COMMUNITY_SELF_REACTION');
        writeGate();
        post.likes.add(server.viewer);
        return ok({ liked: true, likeCount: post.likes.size });
      }
      post.likes.delete(server.viewer);
      return ok({ liked: false, likeCount: post.likes.size });
    }
    match = route.match(/^\/community\/posts\/([^/]+)\/comments$/);
    if (method === 'post' && match) {
      const post = findPost(match[1]);
      const receipt = server.receipts.get(`comment:${server.viewer}:${body.clientRequestId}`);
      if (receipt) return ok({ comment: commentView(server.comments.find((item) => item.id === receipt)), replayed: true });
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (![...text].length || [...text].length > 300) throw httpError(400, 'INVALID_COMMUNITY_COMMENT');
      writeGate();
      // The anonymous post's own author always comments anonymously (contract §3.3).
      const anonymous = post.anonymous && post.userId === server.viewer ? true : body.anonymous;
      const comment = server.addComment({ postId: post.id, userId: server.viewer, body: text, anonymous,
        parentCommentId: body.parentCommentId ?? null, ageMinutes: 0 });
      server.receipts.set(`comment:${server.viewer}:${body.clientRequestId}`, comment.id);
      return ok({ comment: commentView(comment), replayed: false });
    }
    throw new Error(`community server: unexpected ${method.toUpperCase()} ${path}`);
  }

  async function answer(method, path, body) {
    const result = await respond(method, path, body);
    const lost = server.lostAnswers.findIndex((item) => item.method === method && path.startsWith(item.path));
    if (lost >= 0) { server.lostAnswers.splice(lost, 1); throw networkError(); }
    return result;
  }
  server.client = {
    get: (path) => answer('get', path),
    post: (path, body) => answer('post', path, body),
    put: (path, body) => answer('put', path, body),
    delete: (path) => answer('delete', path),
  };
  server.getMe = async () => {
    server.requests.push({ method: 'get', path: '/me' });
    const failure = server.meFailures.shift();
    if (failure) throw failure;
    const user = server.users[server.viewer];
    return { id: user.userId, nickname: user.nickname, role: user.role };
  };
  /** What a request carried: the multipart payload as JSON, other bodies as sent. */
  server.sent = (method, route) => server.requests.filter((item) => item.method === method && item.path.split('?')[0] === route)
    .map((item) => (item.body && typeof item.body.get === 'function' ? { ...JSON.parse(item.body.get('payload')), photoCount: item.body.getAll('photos').length } : item.body));
  return server;
}

function communityHarness({ platform = 'android', mode = 'light', financialPreference = 'red_blue', seedMe = true } = {}) {
  const h = interactionHarness(platform);
  const server = communityServer();
  const { createElement } = React;
  h.server = server;
  h.navigations = [];
  h.rootNavigations = [];
  h.options = {};
  h.focused = true;
  h.picked = [];
  h.appearance = { mode, financialPreference };
  const focusEffects = new Set();
  function FlatList({ data, renderItem, keyExtractor, ListEmptyComponent, ListHeaderComponent, ListFooterComponent, ...props }) {
    const part = (value) => (value == null || React.isValidElement(value) ? value ?? null : createElement(value));
    return createElement('FlatList', props, part(ListHeaderComponent),
      data.length ? data.map((item, index) => createElement(React.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })))
        : part(ListEmptyComponent),
      part(ListFooterComponent));
  }
  h.appListeners = [];
  Object.assign(h.native, {
    FlatList, TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView', Image: 'Image',
    Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) },
    AppState: { currentState: 'active', addEventListener: (_type, listener) => {
      h.appListeners.push(listener);
      return { remove: () => h.appListeners.splice(h.appListeners.indexOf(listener), 1) };
    } },
  });
  h.setAppState = async (state) => { await act(async () => h.appListeners.forEach((listener) => listener(state))); };
  h.api = load(resolve(__dirname, '../src/features/community/api.ts'), {
    'react-native': { Platform: { OS: platform } },
    '../../services/api/client': { apiClient: server.client },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => 1, assertCurrentSession() {} },
  });
  const navigation = {
    navigate: (...args) => h.navigations.push(args),
    goBack: () => h.navigations.push(['goBack']),
    setOptions: (options) => { h.options = { ...h.options, ...options }; },
    getParent: () => ({ getState: () => ({ index: 0, routes: [{ name: 'CommunityTab' }] }) }),
  };
  const message = (error) => errorMapper.getErrorMessageFromCode(errorMapper.getApiErrorCode(error));
  h.mocks = {
    'react-native': h.native,
    'react-native-svg': { __esModule: true, default: 'Svg', Path: 'Path', Circle: 'Circle', Rect: 'Rect', Defs: 'Defs', Stop: 'Stop', LinearGradient: 'LinearGradient', RadialGradient: 'RadialGradient' },
    '@react-navigation/native': {
      useIsFocused: () => h.focused,
      useFocusEffect: (effect) => React.useEffect(() => {
        focusEffects.add(effect);
        const cleanup = effect();
        return () => { focusEffects.delete(effect); if (typeof cleanup === 'function') cleanup(); };
      }, [effect]),
    },
    '@react-navigation/elements': { useHeaderHeight: () => 56 },
    '../../theme/useReducedMotion': { useReducedMotion: () => h.reduced, useReducedMotionSettled: () => true },
    '../../app/navigation/navigationHooks': { useCommunityNavigation: () => navigation, useRootNavigation: () => ({ navigate: (...args) => h.rootNavigations.push(args) }) },
    '../../app/navigation/marketTabEntry': { openInMarketTab: (...args) => ['market', ...args] },
    '../../theme/appearance': { useAppearance: () => ({ mode: h.appearance.mode, colors: PALETTES[h.appearance.mode], financialPreference: h.appearance.financialPreference,
      financialColors: getFinancialColors(h.appearance.mode, h.appearance.financialPreference) }) },
    '../../features/community/api': h.api,
    '../../features/me/api': { getMe: server.getMe },
    '../../features/asset/api': { getAssetDetail: async () => { throw new Error('asset detail not mocked'); } },
    '../../features/community/photoPicker': { pickCommunityPhotos: async (remaining) => {
      const next = h.picked.splice(0, remaining);
      return next;
    } },
    '../../components/common/ActionPressable': { __esModule: true, default: h.ActionPressable },
    '../../components/common/ScreenSheetHost': { SheetPortal: ({ children }) => children, useOwnerScreenFocused: () => true },
    '../../components/common/InlineBottomSheet': { __esModule: true, default: ({ visible, testID, title, children }) => (visible ? createElement('Sheet', { testID, title }, children) : null) },
    '../../components/common/CTAButton': { __esModule: true, default: ({ testID, label, state, onPress }) => createElement('CTAButton', { testID, label, state, onPress }) },
    '../../components/common/TopNoticeBanner': { __esModule: true, default: () => null },
    '../../components/states/ErrorNotice': { __esModule: true, default: ({ testID, message: text, error }) => createElement('Text', { testID }, text ?? message(error)) },
    '../../components/states/ErrorState': { __esModule: true, default: (props) => createElement('ErrorState', props) },
    '../../components/states/WhaleLoader': { __esModule: true, default: (props) => createElement('WhaleLoader', props) },
    '../../components/states/InlineEmptyState': { __esModule: true, default: (props) => createElement('InlineEmptyState', props) },
    '../order/OrderAssetSheet': { __esModule: true, default: () => null },
    './CommunitySheets': {
      CommunitySheet: ({ visible, testID, children }) => (visible ? createElement('Sheet', { testID }, children) : null),
      ActionList: (props) => createElement('ActionList', props), ReportSheet: () => null, ModerationSheet: () => null, AccountManageSheet: () => null,
    },
  };
  h.client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (seedMe) h.client.setQueryData(['me'], { id: 'me', nickname: 'demiant', role: 'user' });
  h.screen = (file, mocks = {}) => load(resolve(__dirname, '..', file), { ...h.mocks, ...mocks });
  h.flush = async (rounds = 2) => {
    for (let round = 0; round < rounds; round++) await act(async () => { await new Promise((done) => setTimeout(done, 5)); });
  };
  h.mount = async (element) => {
    h.renderer = h.render(createElement(query.QueryClientProvider, { client: h.client }, element));
    await h.flush();
    return h.renderer;
  };
  h.refocus = async () => { await act(async () => { for (const effect of [...focusEffects]) effect(); }); await h.flush(); };
  h.close = async () => { if (h.renderer) await act(async () => h.renderer.unmount()); h.client.clear(); };
  /** Host nodes only (composites share their host's testID). */
  h.all = (id) => h.renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === id);
  h.node = (id) => h.all(id)[0];
  h.exists = (id) => h.all(id).length > 0;
  h.press = async (id) => {
    const target = h.node(id);
    if (!target) throw new Error(`no ${id}`);
    await act(async () => target.props.onPress?.({}));
    await h.flush();
  };
  h.type = async (id, value) => { await act(async () => h.node(id).props.onChangeText(value)); await h.flush(1); };
  h.text = (node = h.renderer.root) => node.findAll((item) => item.type === 'Text').map((item) => [item.props.children].flat().filter((part) => typeof part === 'string' || typeof part === 'number').join('')).join('\n');
  h.style = (node) => flatten(node.props.style);
  return h;
}

module.exports = { communityHarness, communityServer, httpError, networkError, deferred, NOW, HOUR, PALETTES, React, act, flatten };
