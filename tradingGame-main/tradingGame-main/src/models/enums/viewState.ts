export type GlobalViewState =
  | 'idle'
  | 'loading'
  | 'success'
  | 'empty'
  | 'error'
  | 'blocked';

export type SeasonDomainState =
  | 'season_upcoming'
  | 'season_active_joined'
  | 'season_active_not_joined'
  | 'season_ended_unsettled'
  | 'season_settled';

export type AuthViewState =
  | 'auth_idle'
  | 'auth_submitting'
  | 'auth_invalid_input'
  | 'auth_failed'
  | 'auth_success';

export type SeasonJoinViewState =
  | 'season_info_loading'
  | 'season_upcoming_view'
  | 'season_active_not_joined_view'
  | 'season_join_submitting'
  | 'season_join_failed'
  | 'season_join_success'
  | 'season_settled_view';

export type HomeViewState =
  | 'home_loading'
  | 'home_active_joined'
  | 'home_active_not_joined'
  | 'home_upcoming'
  | 'home_ended_unsettled'
  | 'home_settled'
  | 'home_no_positions'
  | 'home_partial_error'
  | 'home_error';

export type WalletFxViewState =
  | 'wallet_loading'
  | 'wallet_ready'
  | 'wallet_empty_default'
  | 'fx_quote_loading'
  | 'fx_quote_ready'
  | 'fx_quote_invalid'
  | 'fx_execute_submitting'
  | 'fx_execute_success'
  | 'fx_execute_rejected'
  | 'wallet_error';

export type MarketViewState =
  | 'market_loading'
  | 'market_ready'
  | 'market_empty_search'
  | 'market_paginating'
  | 'market_error';

export type AssetDetailViewState =
  | 'asset_loading'
  | 'asset_ready_tradable'
  | 'asset_ready_not_holding'
  | 'asset_market_closed'
  | 'asset_season_blocked'
  | 'asset_price_stale'
  | 'asset_chart_error'
  | 'asset_error';

export type OrderFlowState =
  | 'order_input_idle'
  | 'order_input_invalid'
  | 'order_quote_loading'
  | 'order_quote_ready'
  | 'order_quote_rejected'
  | 'order_submitting'
  | 'order_success'
  | 'order_failed';

export type RankingViewState =
  | 'ranking_loading'
  | 'ranking_ready'
  | 'ranking_empty'
  | 'ranking_partial_unjoined'
  | 'ranking_settled'
  | 'ranking_error';

export type RecordViewState =
  | 'record_list_loading'
  | 'record_list_ready'
  | 'record_list_empty'
  | 'record_list_error'
  | 'record_detail_loading'
  | 'record_detail_ready'
  | 'record_detail_missing'
  | 'record_detail_error'
  | 'record_orders_loading'
  | 'record_orders_ready'
  | 'record_orders_empty'
  | 'record_orders_error'
  | 'record_exchanges_loading'
  | 'record_exchanges_ready'
  | 'record_exchanges_empty'
  | 'record_exchanges_error';

export type RewardViewState =
  | 'reward_loading'
  | 'reward_ready'
  | 'reward_empty'
  | 'reward_pending_settlement'
  | 'reward_error';