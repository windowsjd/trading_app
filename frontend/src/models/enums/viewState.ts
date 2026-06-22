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
  | 'season_settled_joined'
  | 'season_settled_not_joined'
  | 'season_not_configured';

export type AuthViewState =
  | 'auth_idle'
  | 'auth_submitting'
  | 'auth_invalid_input'
  | 'auth_suspended'
  | 'auth_deleted'
  | 'auth_failed'
  | 'auth_success';

export type SeasonJoinViewState =
  | 'season_info_loading'
  | 'season_upcoming_view'
  | 'season_active_not_joined_view'
  | 'season_ended_unsettled_view'
  | 'season_join_submitting'
  | 'season_join_already_joined'
  | 'season_join_closed'
  | 'season_join_error'
  | 'season_join_failed'
  | 'season_join_success'
  | 'season_settled_view'
  | 'season_not_configured_view';

export type HomeViewState =
  | 'home_loading'
  | 'home_no_current_season'
  | 'home_active_joined'
  | 'home_active_not_joined'
  | 'home_upcoming'
  | 'home_ended_unsettled'
  | 'home_settled'
  | 'home_settled_not_joined'
  | 'home_no_positions'
  | 'home_partial_error'
  | 'home_error';

export type WalletFxViewState =
  | 'wallet_loading'
  | 'wallet_ready'
  | 'wallet_not_joined'
  | 'wallet_unavailable'
  | 'wallet_error'
  | 'fx_input_idle'
  | 'fx_input_invalid'
  | 'fx_quote_loading'
  | 'fx_quote_ready'
  | 'fx_quote_expired'
  | 'fx_quote_rejected'
  | 'fx_execute_submitting'
  | 'fx_execute_success'
  | 'fx_execute_requote_required'
  | 'fx_execute_rejected'
  | 'fx_idempotency_conflict';

export type MarketViewState =
  | 'market_loading'
  | 'market_ready'
  | 'market_empty_search'
  | 'market_paginating'
  | 'market_partial_price_unavailable'
  | 'market_error';

export type AssetDetailViewState =
  | 'asset_loading'
  | 'asset_ready_tradable'
  | 'asset_ready_not_holding'
  | 'asset_market_closed'
  | 'asset_season_blocked'
  | 'asset_price_stale'
  | 'asset_price_unavailable'
  | 'asset_position_unavailable'
  | 'asset_chart_unavailable'
  | 'asset_chart_error'
  | 'asset_error';

export type OrderFlowState =
  | 'order_input_idle'
  | 'order_input_invalid'
  | 'order_quote_loading'
  | 'order_quote_ready'
  | 'order_quote_expired'
  | 'order_quote_rejected'
  | 'order_submitting'
  | 'order_success'
  | 'order_requote_required'
  | 'order_idempotency_conflict'
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
