-- AtlasAI canonical schema.
--
-- Safety boundary: every object is fully qualified into `atlasai`. This file
-- does not read from, write to, alter, or drop anything in `webserver_hpa`.
--
-- Time contract: every point in time is stored as Unix epoch milliseconds in
-- a BIGINT UNSIGNED column ending in `_unix_ms`. No SQL temporal column types
-- are used.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE `atlasai`.`inference_providers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_key` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `display_name` VARCHAR(128) NOT NULL,
  `adapter_key` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `api_base_url` VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `credential_env_key` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inference_providers_key` (`provider_key`),
  CONSTRAINT `chk_inference_providers_time_order` CHECK (`updated_unix_ms` >= `created_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`inference_models` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_id` BIGINT UNSIGNED NOT NULL,
  `config_key` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `model_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  `display_name` VARCHAR(255) NOT NULL,
  `status` ENUM('inactive','active','disabled') NOT NULL DEFAULT 'inactive',
  `active_singleton` TINYINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN `status` = 'active' THEN 1 ELSE NULL END
  ) STORED,
  `supports_streaming` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `supports_tools` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `supports_json_mode` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `supports_tool_role_messages` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `supports_vision` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `supports_reasoning` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `reasoning_effort` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Sent as reasoning_effort by the OpenAI-compatible adapter when set',
  `max_context_tokens` INT UNSIGNED NULL,
  `max_output_tokens` INT UNSIGNED NULL,
  `default_output_tokens` INT UNSIGNED NOT NULL DEFAULT 8192,
  `request_timeout_ms` INT UNSIGNED NOT NULL DEFAULT 120000,
  `max_retries` TINYINT UNSIGNED NOT NULL DEFAULT 2,
  `input_price_microusd_per_million_tokens` BIGINT UNSIGNED NULL,
  `cached_input_price_microusd_per_million_tokens` BIGINT UNSIGNED NULL COMMENT 'Price of prompt tokens served from the provider cache',
  `output_price_microusd_per_million_tokens` BIGINT UNSIGNED NULL,
  `price_source_url` VARCHAR(2048) NULL,
  `price_verified_unix_ms` BIGINT UNSIGNED NULL,
  `visitor_selectable` TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Offered in the visitor model picker',
  `catalog_verified_unix_ms` BIGINT UNSIGNED NOT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inference_models_config_key` (`config_key`),
  KEY `idx_inference_models_selectable` (`visitor_selectable`, `status`, `id`),
  UNIQUE KEY `uq_inference_models_provider_model` (`provider_id`, `model_id`),
  UNIQUE KEY `uq_inference_models_one_active` (`active_singleton`),
  KEY `idx_inference_models_status_provider` (`status`, `provider_id`, `id`),
  CONSTRAINT `fk_inference_models_provider`
    FOREIGN KEY (`provider_id`) REFERENCES `atlasai`.`inference_providers` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_inference_models_streaming` CHECK (`supports_streaming` IN (0, 1)),
  CONSTRAINT `chk_inference_models_tools` CHECK (`supports_tools` IN (0, 1)),
  CONSTRAINT `chk_inference_models_json` CHECK (`supports_json_mode` IN (0, 1)),
  CONSTRAINT `chk_inference_models_tool_roles` CHECK (`supports_tool_role_messages` IN (0, 1)),
  CONSTRAINT `chk_inference_models_vision` CHECK (`supports_vision` IN (0, 1)),
  CONSTRAINT `chk_inference_models_reasoning` CHECK (`supports_reasoning` IN (0, 1)),
  CONSTRAINT `chk_inference_models_reasoning_effort` CHECK (`reasoning_effort` IS NULL OR `reasoning_effort` IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
  CONSTRAINT `chk_inference_models_selectable` CHECK (`visitor_selectable` IN (0, 1)),
  CONSTRAINT `chk_inference_models_prices` CHECK (
    (`input_price_microusd_per_million_tokens` IS NULL AND `output_price_microusd_per_million_tokens` IS NULL AND `cached_input_price_microusd_per_million_tokens` IS NULL AND `price_verified_unix_ms` IS NULL)
    OR (`input_price_microusd_per_million_tokens` IS NOT NULL AND `output_price_microusd_per_million_tokens` IS NOT NULL AND `price_verified_unix_ms` IS NOT NULL)
  ),
  CONSTRAINT `chk_inference_models_output_tokens` CHECK (
    `default_output_tokens` > 0
    AND (`max_output_tokens` IS NULL OR `default_output_tokens` <= `max_output_tokens`)
  ),
  CONSTRAINT `chk_inference_models_time_order` CHECK (`updated_unix_ms` >= `created_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`visitors` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `first_seen_unix_ms` BIGINT UNSIGNED NOT NULL,
  `last_seen_unix_ms` BIGINT UNSIGNED NOT NULL,
  `request_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_visitors_public_id` (`public_id`),
  KEY `idx_visitors_last_seen` (`last_seen_unix_ms`, `id`),
  KEY `idx_visitors_status_last_seen` (`status`, `last_seen_unix_ms`, `id`),
  CONSTRAINT `chk_visitors_time_order` CHECK (`last_seen_unix_ms` >= `first_seen_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`auth_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `refresh_family_id` BINARY(16) NOT NULL,
  `access_token_sha256` BINARY(32) NOT NULL COMMENT 'Only the SHA-256 digest is stored',
  `csrf_token_sha256` BINARY(32) NOT NULL COMMENT 'Only the SHA-256 digest is stored',
  `status` ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  `access_expires_unix_ms` BIGINT UNSIGNED NOT NULL,
  `idle_expires_unix_ms` BIGINT UNSIGNED NOT NULL,
  `absolute_expires_unix_ms` BIGINT UNSIGNED NOT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `last_seen_unix_ms` BIGINT UNSIGNED NOT NULL,
  `revoked_unix_ms` BIGINT UNSIGNED NULL,
  `revocation_reason` VARCHAR(255) NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_auth_sessions_public_id` (`public_id`),
  UNIQUE KEY `uq_auth_sessions_access_token` (`access_token_sha256`),
  UNIQUE KEY `uq_auth_sessions_csrf_token` (`csrf_token_sha256`),
  UNIQUE KEY `uq_auth_sessions_id_visitor` (`id`, `visitor_id`),
  KEY `idx_auth_sessions_visitor_status` (`visitor_id`, `status`, `last_seen_unix_ms`, `id`),
  KEY `idx_auth_sessions_family` (`refresh_family_id`, `status`, `id`),
  KEY `idx_auth_sessions_access_expiry` (`status`, `access_expires_unix_ms`, `id`),
  KEY `idx_auth_sessions_idle_expiry` (`status`, `idle_expires_unix_ms`, `id`),
  CONSTRAINT `fk_auth_sessions_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_auth_sessions_expiry_order` CHECK (
    `access_expires_unix_ms` > `created_unix_ms`
    AND `idle_expires_unix_ms` >= `access_expires_unix_ms`
    AND `absolute_expires_unix_ms` >= `idle_expires_unix_ms`
    AND `last_seen_unix_ms` >= `created_unix_ms`
  ),
  CONSTRAINT `chk_auth_sessions_revocation` CHECK (
    (`status` = 'revoked' AND `revoked_unix_ms` IS NOT NULL AND `revocation_reason` IS NOT NULL)
    OR (`status` <> 'revoked' AND `revoked_unix_ms` IS NULL AND `revocation_reason` IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`auth_refresh_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `session_id` BIGINT UNSIGNED NOT NULL,
  `parent_token_id` BIGINT UNSIGNED NULL,
  `token_sha256` BINARY(32) NOT NULL COMMENT 'Only the SHA-256 digest is stored',
  `status` ENUM('active','rotated','revoked','reused','expired') NOT NULL DEFAULT 'active',
  `active_session_id` BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN `status` = 'active' THEN `session_id` ELSE NULL END
  ) STORED,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `expires_unix_ms` BIGINT UNSIGNED NOT NULL,
  `consumed_unix_ms` BIGINT UNSIGNED NULL,
  `revoked_unix_ms` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_auth_refresh_tokens_hash` (`token_sha256`),
  UNIQUE KEY `uq_auth_refresh_tokens_one_active` (`active_session_id`),
  UNIQUE KEY `uq_auth_refresh_tokens_id_session` (`id`, `session_id`),
  KEY `idx_auth_refresh_tokens_session` (`session_id`, `status`, `id`),
  KEY `idx_auth_refresh_tokens_parent` (`parent_token_id`),
  KEY `idx_auth_refresh_tokens_expiry` (`status`, `expires_unix_ms`, `id`),
  CONSTRAINT `fk_auth_refresh_tokens_session`
    FOREIGN KEY (`session_id`) REFERENCES `atlasai`.`auth_sessions` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_auth_refresh_tokens_parent_session`
    FOREIGN KEY (`parent_token_id`, `session_id`)
    REFERENCES `atlasai`.`auth_refresh_tokens` (`id`, `session_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_auth_refresh_tokens_expiry` CHECK (`expires_unix_ms` > `created_unix_ms`),
  CONSTRAINT `chk_auth_refresh_tokens_consumed` CHECK (
    (`status` IN ('rotated','reused') AND `consumed_unix_ms` IS NOT NULL)
    OR (`status` NOT IN ('rotated','reused') AND `consumed_unix_ms` IS NULL)
  ),
  CONSTRAINT `chk_auth_refresh_tokens_revoked` CHECK (
    (`status` = 'revoked' AND `revoked_unix_ms` IS NOT NULL)
    OR (`status` <> 'revoked' AND `revoked_unix_ms` IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`request_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `visitor_id` BIGINT UNSIGNED NULL,
  `auth_session_id` BIGINT UNSIGNED NULL,
  `received_unix_ms` BIGINT UNSIGNED NOT NULL,
  `ingress` ENUM('cloudflare','direct','internal') NOT NULL,

  `request_method` ENUM('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','CONNECT','TRACE') NOT NULL,
  `request_scheme` ENUM('http','https') NOT NULL,
  `request_protocol` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `request_host` VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `request_port` SMALLINT UNSIGNED NULL,
  `route_key` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `request_path` TEXT NOT NULL COMMENT 'Path only; query values are not stored',
  `query_parameter_count` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `query_string_bytes` INT UNSIGNED NOT NULL DEFAULT 0,
  `request_body_bytes` BIGINT UNSIGNED NULL,
  `request_content_type` VARCHAR(255) NULL,
  `request_content_encoding` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `response_status` SMALLINT UNSIGNED NULL,
  `response_body_bytes` BIGINT UNSIGNED NULL,
  `response_content_type` VARCHAR(255) NULL,
  `duration_us` BIGINT UNSIGNED NULL,

  `client_ip` VARBINARY(16) NULL COMMENT 'Normalized trusted client address',
  `trusted_proxy_hops` SMALLINT UNSIGNED NULL,
  `x_forwarded_proto` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `x_forwarded_host` VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `x_forwarded_port` SMALLINT UNSIGNED NULL,
  `cf_connecting_ip` VARBINARY(16) NULL,
  `cf_connecting_ipv6` VARBINARY(16) NULL,
  `cf_pseudo_ipv4` VARBINARY(16) NULL,
  `cf_true_client_ip` VARBINARY(16) NULL,
  `cf_connecting_o2o` TINYINT UNSIGNED NULL,
  `cf_ray_id` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_ray_colo` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_worker_colo` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_visitor_scheme` ENUM('http','https') NULL,
  `cf_worker` VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_cdn_loop` VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_ew_via` VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,

  `cf_country_code` CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_continent_code` CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_is_eu_country` TINYINT UNSIGNED NULL,
  `cf_city` VARCHAR(128) NULL,
  `cf_region` VARCHAR(128) NULL,
  `cf_region_code` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_postal_code` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_metro_code` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_timezone` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_latitude` DECIMAL(9,6) NULL,
  `cf_longitude` DECIMAL(9,6) NULL,
  `cf_asn` BIGINT UNSIGNED NULL,
  `cf_as_organization` VARCHAR(255) NULL,

  `cf_http_protocol` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_version` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_cipher` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_client_tcp_rtt_ms` INT UNSIGNED NULL,
  `cf_client_quic_rtt_ms` INT UNSIGNED NULL,
  `cf_edge_l4_delivery_rate_bytes_per_second` BIGINT UNSIGNED NULL,
  `cf_request_priority` VARCHAR(128) NULL,
  `cf_client_accept_encoding` VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_ciphers_sha1_base64` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_extensions_sha1_base64` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_extensions_sha1_le_base64` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_hello_length_bytes` INT UNSIGNED NULL,
  `cf_tls_client_random` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,

  `cf_tls_client_auth_cert_presented` TINYINT UNSIGNED NULL,
  `cf_tls_client_auth_cert_revoked` TINYINT UNSIGNED NULL,
  `cf_tls_client_auth_cert_verified` TEXT NULL,
  `cf_tls_client_auth_cert_issuer_dn` TEXT NULL,
  `cf_tls_client_auth_cert_subject_dn` TEXT NULL,
  `cf_tls_client_auth_cert_issuer_dn_rfc2253` TEXT NULL,
  `cf_tls_client_auth_cert_subject_dn_rfc2253` TEXT NULL,
  `cf_tls_client_auth_cert_issuer_dn_legacy` TEXT NULL,
  `cf_tls_client_auth_cert_subject_dn_legacy` TEXT NULL,
  `cf_tls_client_auth_cert_serial` VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_auth_cert_issuer_serial` VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_auth_cert_fingerprint_sha256` BINARY(32) NULL,
  `cf_tls_client_auth_cert_fingerprint_sha1` BINARY(20) NULL,
  `cf_tls_client_auth_cert_not_before_unix_ms` BIGINT UNSIGNED NULL,
  `cf_tls_client_auth_cert_not_after_unix_ms` BIGINT UNSIGNED NULL,
  `cf_tls_client_auth_cert_ski` VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_auth_cert_issuer_ski` VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_auth_cert_rfc9440` MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_auth_cert_rfc9440_too_large` TINYINT UNSIGNED NULL,
  `cf_tls_client_auth_cert_chain_rfc9440` MEDIUMTEXT CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_tls_client_auth_cert_chain_rfc9440_too_large` TINYINT UNSIGNED NULL,

  `cf_bot_score` TINYINT UNSIGNED NULL,
  `cf_verified_bot` TINYINT UNSIGNED NULL,
  `cf_signed_agent` TINYINT UNSIGNED NULL,
  `cf_verified_bot_category` VARCHAR(128) NULL,
  `cf_js_detection_passed` TINYINT UNSIGNED NULL,
  `cf_corporate_proxy` TINYINT UNSIGNED NULL,
  `cf_static_resource` TINYINT UNSIGNED NULL,
  `cf_ja3_hash` CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_ja4_fingerprint` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cf_ja4_h2h3_ratio_1h` DECIMAL(18,15) NULL,
  `cf_ja4_heuristic_ratio_1h` DECIMAL(18,15) NULL,
  `cf_ja4_browser_ratio_1h` DECIMAL(18,15) NULL,
  `cf_ja4_cache_ratio_1h` DECIMAL(18,15) NULL,
  `cf_ja4_reqs_quantile_1h` DECIMAL(18,15) NULL,
  `cf_ja4_ips_quantile_1h` DECIMAL(18,15) NULL,
  `cf_ja4_uas_rank_1h` BIGINT UNSIGNED NULL,
  `cf_ja4_paths_rank_1h` BIGINT UNSIGNED NULL,
  `cf_ja4_reqs_rank_1h` BIGINT UNSIGNED NULL,
  `cf_ja4_ips_rank_1h` BIGINT UNSIGNED NULL,
  `cf_exposed_credential_check` TINYINT UNSIGNED NULL,
  `cf_malicious_uploads_detection` TINYINT UNSIGNED NULL,

  `user_agent` TEXT NULL,
  `accept` TEXT NULL,
  `accept_language` TEXT NULL,
  `accept_encoding` TEXT NULL,
  `referer` TEXT NULL,
  `origin` TEXT NULL,
  `sec_fetch_site` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sec_fetch_mode` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sec_fetch_dest` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sec_fetch_user` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sec_ch_ua` TEXT NULL,
  `sec_ch_ua_full_version` VARCHAR(128) NULL,
  `sec_ch_ua_full_version_list` TEXT NULL,
  `sec_ch_ua_platform` VARCHAR(128) NULL,
  `sec_ch_ua_platform_version` VARCHAR(128) NULL,
  `sec_ch_ua_mobile` TINYINT UNSIGNED NULL,
  `sec_ch_ua_model` VARCHAR(255) NULL,
  `sec_ch_ua_arch` VARCHAR(64) NULL,
  `sec_ch_ua_bitness` VARCHAR(32) NULL,
  `sec_ch_ua_wow64` TINYINT UNSIGNED NULL,
  `do_not_track` TINYINT UNSIGNED NULL,
  `global_privacy_control` TINYINT UNSIGNED NULL,
  `traceparent` VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `tracestate` TEXT CHARACTER SET ascii COLLATE ascii_bin NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_request_events_public_id` (`public_id`),
  KEY `idx_request_events_visitor_time` (`visitor_id`, `received_unix_ms`, `id`),
  KEY `idx_request_events_session_time` (`auth_session_id`, `received_unix_ms`, `id`),
  KEY `idx_request_events_received` (`received_unix_ms`, `id`),
  KEY `idx_request_events_client_ip_time` (`client_ip`, `received_unix_ms`, `id`),
  KEY `idx_request_events_cf_ray` (`cf_ray_id`),
  KEY `idx_request_events_route_time` (`route_key`, `received_unix_ms`, `id`),
  KEY `idx_request_events_country_time` (`cf_country_code`, `received_unix_ms`, `id`),
  KEY `idx_request_events_asn_time` (`cf_asn`, `received_unix_ms`, `id`),
  KEY `idx_request_events_bot_time` (`cf_bot_score`, `received_unix_ms`, `id`),
  KEY `idx_request_events_ja4_time` (`cf_ja4_fingerprint`, `received_unix_ms`, `id`),
  CONSTRAINT `fk_request_events_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_request_events_auth_session_visitor`
    FOREIGN KEY (`auth_session_id`, `visitor_id`)
    REFERENCES `atlasai`.`auth_sessions` (`id`, `visitor_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_request_events_session_shape`
    CHECK (`auth_session_id` IS NULL OR `visitor_id` IS NOT NULL),
  CONSTRAINT `chk_request_events_response_status`
    CHECK (`response_status` IS NULL OR `response_status` BETWEEN 100 AND 599),
  CONSTRAINT `chk_request_events_latitude`
    CHECK (`cf_latitude` IS NULL OR `cf_latitude` BETWEEN -90 AND 90),
  CONSTRAINT `chk_request_events_longitude`
    CHECK (`cf_longitude` IS NULL OR `cf_longitude` BETWEEN -180 AND 180),
  CONSTRAINT `chk_request_events_bot_score`
    CHECK (`cf_bot_score` IS NULL OR `cf_bot_score` BETWEEN 1 AND 99),
  CONSTRAINT `chk_request_events_cf_eu` CHECK (`cf_is_eu_country` IS NULL OR `cf_is_eu_country` IN (0, 1)),
  CONSTRAINT `chk_request_events_cf_o2o` CHECK (`cf_connecting_o2o` IS NULL OR `cf_connecting_o2o` IN (0, 1)),
  CONSTRAINT `chk_request_events_verified_bot` CHECK (`cf_verified_bot` IS NULL OR `cf_verified_bot` IN (0, 1)),
  CONSTRAINT `chk_request_events_signed_agent` CHECK (`cf_signed_agent` IS NULL OR `cf_signed_agent` IN (0, 1)),
  CONSTRAINT `chk_request_events_js` CHECK (`cf_js_detection_passed` IS NULL OR `cf_js_detection_passed` IN (0, 1)),
  CONSTRAINT `chk_request_events_corporate` CHECK (`cf_corporate_proxy` IS NULL OR `cf_corporate_proxy` IN (0, 1)),
  CONSTRAINT `chk_request_events_static` CHECK (`cf_static_resource` IS NULL OR `cf_static_resource` IN (0, 1)),
  CONSTRAINT `chk_request_events_cert_presented` CHECK (`cf_tls_client_auth_cert_presented` IS NULL OR `cf_tls_client_auth_cert_presented` IN (0, 1)),
  CONSTRAINT `chk_request_events_cert_revoked` CHECK (`cf_tls_client_auth_cert_revoked` IS NULL OR `cf_tls_client_auth_cert_revoked` IN (0, 1)),
  CONSTRAINT `chk_request_events_cert_large` CHECK (`cf_tls_client_auth_cert_rfc9440_too_large` IS NULL OR `cf_tls_client_auth_cert_rfc9440_too_large` IN (0, 1)),
  CONSTRAINT `chk_request_events_chain_large` CHECK (`cf_tls_client_auth_cert_chain_rfc9440_too_large` IS NULL OR `cf_tls_client_auth_cert_chain_rfc9440_too_large` IN (0, 1)),
  CONSTRAINT `chk_request_events_cert_time` CHECK (
    `cf_tls_client_auth_cert_not_before_unix_ms` IS NULL
    OR `cf_tls_client_auth_cert_not_after_unix_ms` IS NULL
    OR `cf_tls_client_auth_cert_not_after_unix_ms` >= `cf_tls_client_auth_cert_not_before_unix_ms`
  ),
  CONSTRAINT `chk_request_events_ja4_h2h3` CHECK (`cf_ja4_h2h3_ratio_1h` IS NULL OR `cf_ja4_h2h3_ratio_1h` BETWEEN 0 AND 1),
  CONSTRAINT `chk_request_events_ja4_heuristic` CHECK (`cf_ja4_heuristic_ratio_1h` IS NULL OR `cf_ja4_heuristic_ratio_1h` BETWEEN 0 AND 1),
  CONSTRAINT `chk_request_events_ja4_browser` CHECK (`cf_ja4_browser_ratio_1h` IS NULL OR `cf_ja4_browser_ratio_1h` BETWEEN 0 AND 1),
  CONSTRAINT `chk_request_events_ja4_cache` CHECK (`cf_ja4_cache_ratio_1h` IS NULL OR `cf_ja4_cache_ratio_1h` BETWEEN 0 AND 1),
  CONSTRAINT `chk_request_events_ja4_reqs_q` CHECK (`cf_ja4_reqs_quantile_1h` IS NULL OR `cf_ja4_reqs_quantile_1h` BETWEEN 0 AND 1),
  CONSTRAINT `chk_request_events_ja4_ips_q` CHECK (`cf_ja4_ips_quantile_1h` IS NULL OR `cf_ja4_ips_quantile_1h` BETWEEN 0 AND 1),
  CONSTRAINT `chk_request_events_exposed_credential` CHECK (`cf_exposed_credential_check` IS NULL OR `cf_exposed_credential_check` BETWEEN 1 AND 4),
  CONSTRAINT `chk_request_events_malicious_upload` CHECK (`cf_malicious_uploads_detection` IS NULL OR `cf_malicious_uploads_detection` BETWEEN 1 AND 3),
  CONSTRAINT `chk_request_events_mobile` CHECK (`sec_ch_ua_mobile` IS NULL OR `sec_ch_ua_mobile` IN (0, 1)),
  CONSTRAINT `chk_request_events_wow64` CHECK (`sec_ch_ua_wow64` IS NULL OR `sec_ch_ua_wow64` IN (0, 1)),
  CONSTRAINT `chk_request_events_dnt` CHECK (`do_not_track` IS NULL OR `do_not_track` IN (0, 1)),
  CONSTRAINT `chk_request_events_gpc` CHECK (`global_privacy_control` IS NULL OR `global_privacy_control` IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`request_event_bot_detections` (
  `request_event_id` BIGINT UNSIGNED NOT NULL,
  `detection_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`request_event_id`, `detection_id`),
  KEY `idx_request_bot_detections_id` (`detection_id`, `request_event_id`),
  CONSTRAINT `fk_request_bot_detections_event`
    FOREIGN KEY (`request_event_id`) REFERENCES `atlasai`.`request_events` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`conversations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `title` VARCHAR(512) NOT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_conversations_public_id` (`public_id`),
  KEY `idx_conversations_visitor_updated` (`visitor_id`, `updated_unix_ms`, `id`),
  CONSTRAINT `fk_conversations_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_conversations_time_order` CHECK (`updated_unix_ms` >= `created_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- Human-visible conversation text only. Tool executions live in `runs`, their progress in
-- `run_events`, and every model request in `inference_calls`. An assistant message links to the
-- user message it answers and to the inference call that produced it.
CREATE TABLE `atlasai`.`messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `parent_message_id` BIGINT UNSIGNED NULL COMMENT 'The user message an assistant message answers',
  `inference_call_id` BIGINT UNSIGNED NULL COMMENT 'The inference call that produced an assistant message',
  `role` ENUM('user','assistant') NOT NULL,
  `content_text` LONGTEXT NOT NULL,
  `content_sha256` BINARY(32) NOT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_messages_public_id` (`public_id`),
  UNIQUE KEY `uq_messages_id_conversation` (`id`, `conversation_id`),
  KEY `idx_messages_conversation_order` (`conversation_id`, `id`),
  KEY `idx_messages_parent` (`parent_message_id`),
  KEY `idx_messages_inference_call` (`inference_call_id`),
  CONSTRAINT `fk_messages_conversation`
    FOREIGN KEY (`conversation_id`) REFERENCES `atlasai`.`conversations` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_messages_parent_conversation`
    FOREIGN KEY (`parent_message_id`, `conversation_id`)
    REFERENCES `atlasai`.`messages` (`id`, `conversation_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_messages_parent_role` CHECK (
    (`role` = 'user' AND `parent_message_id` IS NULL)
    OR (`role` = 'assistant' AND `parent_message_id` IS NOT NULL)
  ),
  CONSTRAINT `chk_messages_inference_call_role` CHECK (`inference_call_id` IS NULL OR `role` = 'assistant')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`aso_workspaces` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `inference_model_id` BIGINT UNSIGNED NOT NULL,
  `workflow_key` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` ENUM('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
  `request_text` LONGTEXT NOT NULL,
  `plan_json` JSON NULL,
  `storage_prefix` VARCHAR(2048) NOT NULL,
  `log_uri` VARCHAR(2048) NULL,
  `artifact_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `status_message` VARCHAR(1024) NULL,
  `error_code` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `error_message` TEXT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `started_unix_ms` BIGINT UNSIGNED NULL,
  `finished_unix_ms` BIGINT UNSIGNED NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_aso_workspaces_public_id` (`public_id`),
  KEY `idx_aso_workspaces_visitor_time` (`visitor_id`, `created_unix_ms`, `id`),
  KEY `idx_aso_workspaces_status_time` (`status`, `created_unix_ms`, `id`),
  KEY `idx_aso_workspaces_model_time` (`inference_model_id`, `created_unix_ms`, `id`),
  CONSTRAINT `fk_aso_workspaces_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_aso_workspaces_model`
    FOREIGN KEY (`inference_model_id`) REFERENCES `atlasai`.`inference_models` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_aso_workspaces_time_order` CHECK (
    `updated_unix_ms` >= `created_unix_ms`
    AND (`started_unix_ms` IS NULL OR `started_unix_ms` >= `created_unix_ms`)
    AND (`finished_unix_ms` IS NULL OR `finished_unix_ms` >= `created_unix_ms`)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`aso_artifacts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `workspace_id` BIGINT UNSIGNED NOT NULL,
  `kind` ENUM('tool_result','dataset','measurement','analysis','figure','summary','inspection','cleaned') NOT NULL,
  `type_key` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `format` ENUM('json','png','md','csv','tsv','svg','html','parquet','txt','binary') NOT NULL,
  `name` VARCHAR(512) NOT NULL,
  `producer_key` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purpose` VARCHAR(1024) NULL,
  `storage_uri` VARCHAR(2048) NOT NULL,
  `content_type` VARCHAR(255) NULL,
  `size_bytes` BIGINT UNSIGNED NULL,
  `sha256` BINARY(32) NULL,
  `schema_json` JSON NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_aso_artifacts_public_id` (`public_id`),
  UNIQUE KEY `uq_aso_artifacts_id_workspace` (`id`, `workspace_id`),
  UNIQUE KEY `uq_aso_artifacts_workspace_name` (`workspace_id`, `name`),
  KEY `idx_aso_artifacts_workspace_time` (`workspace_id`, `created_unix_ms`, `id`),
  KEY `idx_aso_artifacts_workspace_kind` (`workspace_id`, `kind`, `id`),
  KEY `idx_aso_artifacts_workspace_type` (`workspace_id`, `type_key`, `id`),
  KEY `idx_aso_artifacts_workspace_hash` (`workspace_id`, `sha256`),
  CONSTRAINT `fk_aso_artifacts_workspace`
    FOREIGN KEY (`workspace_id`) REFERENCES `atlasai`.`aso_workspaces` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`aso_artifact_links` (
  `artifact_id` BIGINT UNSIGNED NOT NULL,
  `workspace_id` BIGINT UNSIGNED NOT NULL,
  `related_artifact_id` BIGINT UNSIGNED NOT NULL,
  `relation` ENUM('source','derived_from','rendered_from') NOT NULL,
  `ordinal` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`artifact_id`, `relation`, `related_artifact_id`),
  KEY `idx_aso_artifact_links_workspace` (`workspace_id`, `relation`, `artifact_id`),
  KEY `idx_aso_artifact_links_related` (`related_artifact_id`, `workspace_id`, `relation`, `artifact_id`),
  CONSTRAINT `fk_aso_artifact_links_artifact_workspace`
    FOREIGN KEY (`artifact_id`, `workspace_id`)
    REFERENCES `atlasai`.`aso_artifacts` (`id`, `workspace_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_aso_artifact_links_related_workspace`
    FOREIGN KEY (`related_artifact_id`, `workspace_id`)
    REFERENCES `atlasai`.`aso_artifacts` (`id`, `workspace_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_aso_artifact_links_not_self` CHECK (`artifact_id` <> `related_artifact_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`batch_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `inference_model_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
  `total_queries` BIGINT UNSIGNED NOT NULL,
  `finished_queries` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `succeeded_queries` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `failed_queries` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `error_code` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `error_message` TEXT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `started_unix_ms` BIGINT UNSIGNED NULL,
  `finished_unix_ms` BIGINT UNSIGNED NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batch_jobs_public_id` (`public_id`),
  UNIQUE KEY `uq_batch_jobs_id_model` (`id`, `inference_model_id`),
  KEY `idx_batch_jobs_visitor_time` (`visitor_id`, `created_unix_ms`, `id`),
  KEY `idx_batch_jobs_status_time` (`status`, `created_unix_ms`, `id`),
  KEY `idx_batch_jobs_model_time` (`inference_model_id`, `created_unix_ms`, `id`),
  CONSTRAINT `fk_batch_jobs_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_batch_jobs_model`
    FOREIGN KEY (`inference_model_id`) REFERENCES `atlasai`.`inference_models` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_batch_jobs_counts` CHECK (
    `finished_queries` <= `total_queries`
    AND `succeeded_queries` + `failed_queries` = `finished_queries`
  ),
  CONSTRAINT `chk_batch_jobs_time_order` CHECK (
    `updated_unix_ms` >= `created_unix_ms`
    AND (`started_unix_ms` IS NULL OR `started_unix_ms` >= `created_unix_ms`)
    AND (`finished_unix_ms` IS NULL OR `finished_unix_ms` >= `created_unix_ms`)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`batch_queries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `job_id` BIGINT UNSIGNED NOT NULL,
  `query_index` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('pending','running','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
  `query_text` LONGTEXT NOT NULL,
  `response_text` LONGTEXT NULL,
  `response_json` JSON NULL,
  `inference_model_id` BIGINT UNSIGNED NOT NULL,
  `error_code` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `error_message` TEXT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `started_unix_ms` BIGINT UNSIGNED NULL,
  `finished_unix_ms` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_batch_queries_public_id` (`public_id`),
  UNIQUE KEY `uq_batch_queries_job_index` (`job_id`, `query_index`),
  KEY `idx_batch_queries_job_status` (`job_id`, `status`, `query_index`),
  KEY `idx_batch_queries_status_time` (`status`, `created_unix_ms`, `id`),
  KEY `idx_batch_queries_model_time` (`inference_model_id`, `created_unix_ms`, `id`),
  CONSTRAINT `fk_batch_queries_job_model`
    FOREIGN KEY (`job_id`, `inference_model_id`)
    REFERENCES `atlasai`.`batch_jobs` (`id`, `inference_model_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_batch_queries_model`
    FOREIGN KEY (`inference_model_id`) REFERENCES `atlasai`.`inference_models` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_batch_queries_response` CHECK (
    `status` NOT IN ('completed','failed')
    OR `response_text` IS NOT NULL
    OR `response_json` IS NOT NULL
    OR `error_message` IS NOT NULL
  ),
  CONSTRAINT `chk_batch_queries_time_order` CHECK (
    `updated_unix_ms` >= `created_unix_ms`
    AND (`started_unix_ms` IS NULL OR `started_unix_ms` >= `created_unix_ms`)
    AND (`finished_unix_ms` IS NULL OR `finished_unix_ms` >= `created_unix_ms`)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- One tool execution inside a conversation turn. The model's own arguments, the sentence it
-- streamed before running the tool, the compact result document it received back, and the
-- promoted result scalars the UI links to.
CREATE TABLE `atlasai`.`runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `request_message_id` BIGINT UNSIGNED NOT NULL COMMENT 'The user message that triggered the run',
  `response_message_id` BIGINT UNSIGNED NULL COMMENT 'The assistant message synthesized from the run',
  `request_event_id` BIGINT UNSIGNED NULL,
  `inference_model_id` BIGINT UNSIGNED NOT NULL,
  `tool_key` ENUM('deep_research_hpa','investigator_hpa','check_inclusion_hpa','dictionary_expert_hpa','aso_hpa','clarify_hpa') NOT NULL,
  `tool_call_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL COMMENT 'Provider tool call id',
  `arguments_json` JSON NULL COMMENT 'Tool arguments produced by the model; NULL only for runs migrated from the pre-runs schema',
  `preamble_text` TEXT NULL COMMENT 'Sentence the assistant streamed before running the tool',
  `status` ENUM('running','completed','failed') NOT NULL,
  `step_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `search_url` VARCHAR(2048) NULL,
  `rows_found` INT UNSIGNED NULL,
  `validation_passed` TINYINT UNSIGNED NULL,
  `attempts` SMALLINT UNSIGNED NULL,
  `workspace_id` BIGINT UNSIGNED NULL,
  `result_json` JSON NULL COMMENT 'Tool result document as returned to the model',
  `summary_md` LONGTEXT NULL,
  `error_message` TEXT NULL,
  `started_unix_ms` BIGINT UNSIGNED NOT NULL,
  `completed_unix_ms` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_runs_public_id` (`public_id`),
  KEY `idx_runs_conversation_order` (`conversation_id`, `id`),
  KEY `idx_runs_visitor_time` (`visitor_id`, `started_unix_ms`, `id`),
  KEY `idx_runs_request_message` (`request_message_id`),
  KEY `idx_runs_response_message` (`response_message_id`),
  KEY `idx_runs_request_event` (`request_event_id`),
  KEY `idx_runs_workspace` (`workspace_id`),
  KEY `idx_runs_model_time` (`inference_model_id`, `started_unix_ms`, `id`),
  KEY `idx_runs_tool_time` (`tool_key`, `started_unix_ms`, `id`),
  CONSTRAINT `fk_runs_conversation`
    FOREIGN KEY (`conversation_id`) REFERENCES `atlasai`.`conversations` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_runs_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_runs_request_message`
    FOREIGN KEY (`request_message_id`, `conversation_id`)
    REFERENCES `atlasai`.`messages` (`id`, `conversation_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_runs_response_message`
    FOREIGN KEY (`response_message_id`, `conversation_id`)
    REFERENCES `atlasai`.`messages` (`id`, `conversation_id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_runs_request_event`
    FOREIGN KEY (`request_event_id`) REFERENCES `atlasai`.`request_events` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_runs_model`
    FOREIGN KEY (`inference_model_id`) REFERENCES `atlasai`.`inference_models` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_runs_workspace`
    FOREIGN KEY (`workspace_id`) REFERENCES `atlasai`.`aso_workspaces` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_runs_completion` CHECK (
    (`status` = 'running' AND `completed_unix_ms` IS NULL)
    OR (`status` <> 'running' AND `completed_unix_ms` IS NOT NULL AND `completed_unix_ms` >= `started_unix_ms`)
  ),
  CONSTRAINT `chk_runs_validation` CHECK (`validation_passed` IS NULL OR `validation_passed` IN (0, 1)),
  CONSTRAINT `chk_runs_error` CHECK (`status` <> 'failed' OR `error_message` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- Ordered progress of one run: the started event, each agent step, and the completion or failure.
CREATE TABLE `atlasai`.`run_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `run_id` BIGINT UNSIGNED NOT NULL,
  `sequence_no` INT UNSIGNED NOT NULL,
  `event_kind` ENUM('started','progress','completed','failed') NOT NULL,
  `stage` VARCHAR(64) NOT NULL,
  `label` VARCHAR(255) NULL,
  `message` TEXT NULL,
  `url` VARCHAR(2048) NULL,
  `visual` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `detail_json` JSON NULL COMMENT 'Structured step payload emitted by the ASO agent',
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_run_events_sequence` (`run_id`, `sequence_no`),
  CONSTRAINT `fk_run_events_run`
    FOREIGN KEY (`run_id`) REFERENCES `atlasai`.`runs` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- Every request the gateway sends to a model: what it was for, what it cost, how fast it was.
-- Written by the gateway itself, so no caller can skip it. Prompts and responses are hashed,
-- not copied; the conversation text lives in `messages` and tool documents in `runs`.
CREATE TABLE `atlasai`.`inference_calls` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `inference_model_id` BIGINT UNSIGNED NOT NULL,
  `visitor_id` BIGINT UNSIGNED NULL,
  `request_event_id` BIGINT UNSIGNED NULL,
  `conversation_id` BIGINT UNSIGNED NULL,
  `run_id` BIGINT UNSIGNED NULL,
  `batch_query_id` BIGINT UNSIGNED NULL,
  `workspace_id` BIGINT UNSIGNED NULL,
  `credential_source` ENUM('platform','visitor') NOT NULL DEFAULT 'platform' COMMENT 'Whose provider key paid for the call',
  `model_selection` ENUM('auto','visitor','fallback') NOT NULL DEFAULT 'auto' COMMENT 'How the model was chosen for the request',
  `cost_microusd` BIGINT UNSIGNED NULL COMMENT 'Priced from the model row at record time; NULL when the model has no price',
  `purpose` ENUM('router','preface','synthesis','answer','agent','batch','manual') NOT NULL,
  `agent_key` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'Tool whose agent issued the call',
  `status` ENUM('completed','failed') NOT NULL,
  `streamed` TINYINT UNSIGNED NOT NULL,
  `message_count` SMALLINT UNSIGNED NOT NULL,
  `tool_count` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `response_format` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `provider_request_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  `finish_reason` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `tool_call_count` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `response_characters` INT UNSIGNED NULL,
  `input_tokens` BIGINT UNSIGNED NULL,
  `cached_input_tokens` BIGINT UNSIGNED NULL,
  `output_tokens` BIGINT UNSIGNED NULL,
  `reasoning_tokens` BIGINT UNSIGNED NULL,
  `total_tokens` BIGINT UNSIGNED NULL,
  `first_token_latency_ms` INT UNSIGNED NULL COMMENT 'Time to the first content or tool-call delta',
  `total_latency_ms` INT UNSIGNED NULL,
  `output_tokens_per_second` DECIMAL(10,2) GENERATED ALWAYS AS (
    IF(
      `output_tokens` IS NULL OR `total_latency_ms` IS NULL
        OR (`total_latency_ms` - COALESCE(`first_token_latency_ms`, 0)) <= 0,
      NULL,
      ROUND(`output_tokens` / ((`total_latency_ms` - COALESCE(`first_token_latency_ms`, 0)) / 1000), 2)
    )
  ) STORED,
  `error_status` SMALLINT UNSIGNED NULL,
  `error_code` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `error_message` TEXT NULL,
  `request_sha256` BINARY(32) NOT NULL,
  `response_sha256` BINARY(32) NULL,
  `started_unix_ms` BIGINT UNSIGNED NOT NULL,
  `finished_unix_ms` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inference_calls_public_id` (`public_id`),
  KEY `idx_inference_calls_model_time` (`inference_model_id`, `started_unix_ms`, `id`),
  KEY `idx_inference_calls_visitor_time` (`visitor_id`, `credential_source`, `started_unix_ms`, `id`),
  KEY `idx_inference_calls_source_time` (`credential_source`, `started_unix_ms`, `id`),
  KEY `idx_inference_calls_conversation_time` (`conversation_id`, `started_unix_ms`, `id`),
  KEY `idx_inference_calls_run` (`run_id`, `id`),
  KEY `idx_inference_calls_request_event` (`request_event_id`, `id`),
  KEY `idx_inference_calls_batch_query` (`batch_query_id`, `id`),
  KEY `idx_inference_calls_workspace` (`workspace_id`, `id`),
  KEY `idx_inference_calls_status_time` (`status`, `started_unix_ms`, `id`),
  KEY `idx_inference_calls_purpose_time` (`purpose`, `started_unix_ms`, `id`),
  CONSTRAINT `fk_inference_calls_model`
    FOREIGN KEY (`inference_model_id`) REFERENCES `atlasai`.`inference_models` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_inference_calls_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_inference_calls_request_event`
    FOREIGN KEY (`request_event_id`) REFERENCES `atlasai`.`request_events` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_inference_calls_conversation`
    FOREIGN KEY (`conversation_id`) REFERENCES `atlasai`.`conversations` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_inference_calls_run`
    FOREIGN KEY (`run_id`) REFERENCES `atlasai`.`runs` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_inference_calls_batch_query`
    FOREIGN KEY (`batch_query_id`) REFERENCES `atlasai`.`batch_queries` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_inference_calls_workspace`
    FOREIGN KEY (`workspace_id`) REFERENCES `atlasai`.`aso_workspaces` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_inference_calls_streamed` CHECK (`streamed` IN (0, 1)),
  CONSTRAINT `chk_inference_calls_completion` CHECK (
    (`status` = 'completed' AND `finished_unix_ms` IS NOT NULL AND `error_message` IS NULL)
    OR (`status` = 'failed' AND `error_message` IS NOT NULL)
  ),
  CONSTRAINT `chk_inference_calls_time_order` CHECK (`finished_unix_ms` IS NULL OR `finished_unix_ms` >= `started_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

ALTER TABLE `atlasai`.`messages`
  ADD CONSTRAINT `fk_messages_inference_call`
    FOREIGN KEY (`inference_call_id`) REFERENCES `atlasai`.`inference_calls` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Platform policy: spend budgets, per-visitor and global limits, model selection, visitor keys,
-- agent behaviour, and the active HPA data release. Exactly one row is active; edit it in place
-- or insert a new row and flip status. NULL on a limit means "not enforced".
CREATE TABLE `atlasai`.`platform_config` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `label` VARCHAR(128) NOT NULL,
  `status` ENUM('inactive','active') NOT NULL DEFAULT 'inactive',
  `active_singleton` TINYINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN `status` = 'active' THEN 1 ELSE NULL END
  ) STORED,
  `active_hpa_version` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'hpa_datasets rows with this version are kept locally and used offline',
  `offline_agents_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `budget_window_mode` ENUM('rolling','calendar_utc') NOT NULL DEFAULT 'rolling' COMMENT 'rolling = last 24 h / 7 d / 30 d; calendar_utc = current UTC day / ISO week / month',
  `platform_budget_usd_per_day` DECIMAL(12,2) UNSIGNED NULL,
  `platform_budget_usd_per_week` DECIMAL(12,2) UNSIGNED NULL,
  `platform_budget_usd_per_month` DECIMAL(12,2) UNSIGNED NULL,
  `over_budget_behaviour` ENUM('block','fallback_model') NOT NULL DEFAULT 'block',
  `fallback_inference_model_id` BIGINT UNSIGNED NULL,
  `unpriced_model_behaviour` ENUM('allow','block') NOT NULL DEFAULT 'allow' COMMENT 'What to do when the selected model has no price and a budget is set',
  `visitor_budget_usd_per_day` DECIMAL(12,2) UNSIGNED NULL,
  `visitor_budget_usd_per_week` DECIMAL(12,2) UNSIGNED NULL,
  `visitor_budget_usd_per_month` DECIMAL(12,2) UNSIGNED NULL,
  `visitor_requests_per_minute` INT UNSIGNED NULL,
  `visitor_requests_per_hour` INT UNSIGNED NULL,
  `visitor_requests_per_day` INT UNSIGNED NULL,
  `visitor_tokens_per_day` BIGINT UNSIGNED NULL,
  `visitor_runs_per_day` INT UNSIGNED NULL,
  `visitor_aso_runs_per_day` INT UNSIGNED NULL,
  `visitor_concurrent_runs` SMALLINT UNSIGNED NULL,
  `visitor_batch_queries_per_day` INT UNSIGNED NULL,
  `global_requests_per_minute` INT UNSIGNED NULL,
  `global_concurrent_runs` SMALLINT UNSIGNED NULL,
  `visitor_model_selection_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `visitor_provider_keys_enabled` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `visitor_keys_bypass_spend_limits` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `visitor_keys_bypass_volume_limits` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `query_max_characters` INT UNSIGNED NOT NULL DEFAULT 20000,
  `model_history_messages` SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  `batch_max_queries` SMALLINT UNSIGNED NOT NULL DEFAULT 50,
  `batch_concurrency` TINYINT UNSIGNED NOT NULL DEFAULT 2,
  `deep_research_max_retries` TINYINT UNSIGNED NOT NULL DEFAULT 2,
  `aso_max_steps` SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  `aso_parallel_limit` TINYINT UNSIGNED NOT NULL DEFAULT 3,
  `aso_top_x` SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0 keeps every gene the search returns',
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_platform_config_one_active` (`active_singleton`),
  CONSTRAINT `fk_platform_config_fallback_model`
    FOREIGN KEY (`fallback_inference_model_id`) REFERENCES `atlasai`.`inference_models` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_platform_config_flags` CHECK (
    `offline_agents_enabled` IN (0, 1) AND `visitor_model_selection_enabled` IN (0, 1)
    AND `visitor_provider_keys_enabled` IN (0, 1) AND `visitor_keys_bypass_spend_limits` IN (0, 1)
    AND `visitor_keys_bypass_volume_limits` IN (0, 1)
  ),
  CONSTRAINT `chk_platform_config_fallback` CHECK (`over_budget_behaviour` <> 'fallback_model' OR `fallback_inference_model_id` IS NOT NULL),
  CONSTRAINT `chk_platform_config_positive` CHECK (
    `query_max_characters` > 0 AND `model_history_messages` > 0 AND `batch_max_queries` > 0
    AND `batch_concurrency` > 0 AND `aso_max_steps` > 0 AND `aso_parallel_limit` > 0
  ),
  CONSTRAINT `chk_platform_config_time_order` CHECK (`updated_unix_ms` >= `created_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- A visitor's own provider API key, AES-256-GCM encrypted with the server secret. One row per
-- visitor and provider; saving again replaces it, removing deletes it. Only the hash and the
-- last characters are ever shown back.
CREATE TABLE `atlasai`.`visitor_provider_keys` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `provider_id` BIGINT UNSIGNED NOT NULL,
  `key_ciphertext` VARBINARY(2048) NOT NULL,
  `key_nonce` BINARY(12) NOT NULL,
  `key_tag` BINARY(16) NOT NULL,
  `key_sha256` BINARY(32) NOT NULL,
  `key_suffix` VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Last characters, for display only',
  `verified_unix_ms` BIGINT UNSIGNED NOT NULL COMMENT 'When the key last passed a live provider check',
  `use_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `last_used_unix_ms` BIGINT UNSIGNED NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_visitor_provider_keys_public_id` (`public_id`),
  UNIQUE KEY `uq_visitor_provider_keys_pair` (`visitor_id`, `provider_id`),
  KEY `idx_visitor_provider_keys_provider` (`provider_id`, `id`),
  CONSTRAINT `fk_visitor_provider_keys_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_visitor_provider_keys_provider`
    FOREIGN KEY (`provider_id`) REFERENCES `atlasai`.`inference_providers` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_visitor_provider_keys_time_order` CHECK (`updated_unix_ms` >= `created_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- Every refusal or forced fallback the policy layer makes, with the measured value and the
-- limit it hit. Allowed requests need no row: they show up in inference_calls.
CREATE TABLE `atlasai`.`policy_decisions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `request_event_id` BIGINT UNSIGNED NULL,
  `inference_model_id` BIGINT UNSIGNED NULL COMMENT 'The model the request asked for',
  `decision` ENUM('blocked','fallback') NOT NULL,
  `reason` ENUM(
    'platform_budget_day','platform_budget_week','platform_budget_month',
    'visitor_budget_day','visitor_budget_week','visitor_budget_month',
    'visitor_requests_minute','visitor_requests_hour','visitor_requests_day',
    'visitor_tokens_day','visitor_runs_day','visitor_aso_runs_day','visitor_concurrent_runs',
    'visitor_batch_queries_day','global_requests_minute','global_concurrent_runs',
    'unpriced_model','model_selection_disabled','model_not_selectable'
  ) NOT NULL,
  `measured_value` DECIMAL(18,4) NOT NULL,
  `limit_value` DECIMAL(18,4) NOT NULL,
  `route_kind` ENUM('query','batch') NOT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_policy_decisions_visitor_time` (`visitor_id`, `created_unix_ms`, `id`),
  KEY `idx_policy_decisions_reason_time` (`reason`, `created_unix_ms`, `id`),
  KEY `idx_policy_decisions_request_event` (`request_event_id`),
  CONSTRAINT `fk_policy_decisions_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_policy_decisions_request_event`
    FOREIGN KEY (`request_event_id`) REFERENCES `atlasai`.`request_events` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `fk_policy_decisions_model`
    FOREIGN KEY (`inference_model_id`) REFERENCES `atlasai`.`inference_models` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

-- HPA bulk download catalog with the local sync state of every file. Rows are keyed by the catalog ID and
-- filtered by platform_config.active_hpa_version; scripts/sync-hpa-data.js keeps the local_* columns current.
CREATE TABLE `atlasai`.`hpa_datasets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `catalog_id` SMALLINT UNSIGNED NOT NULL COMMENT 'ID column of the HPA bulk download catalog',
  `hpa_version` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Used offline only while it equals platform_config.active_hpa_version',
  `resource` VARCHAR(32) NOT NULL,
  `dataset_name` VARCHAR(64) NOT NULL,
  `description` VARCHAR(255) NOT NULL,
  `file_role` VARCHAR(40) NOT NULL,
  `file_name` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Name of the downloaded file',
  `format` ENUM('TSV','JSON','XML','XSD','Archive') NOT NULL,
  `compression` ENUM('ZIP','GZIP','None') NOT NULL,
  `release_unix_ms` BIGINT UNSIGNED NOT NULL,
  `download_url` VARCHAR(255) NOT NULL,
  `source_page_url` VARCHAR(255) NOT NULL,
  `source_section` VARCHAR(64) NOT NULL,
  `link_text` VARCHAR(64) NOT NULL COMMENT 'Visible label on the HPA page, which can differ from the file name',
  `link_verification` VARCHAR(96) NOT NULL,
  `image_content_status` VARCHAR(64) NOT NULL,
  `duplicate_source_pages` VARCHAR(255) NULL,
  `catalog_checked_unix_ms` BIGINT UNSIGNED NOT NULL,
  `notes` VARCHAR(255) NULL,
  `local_status` ENUM('missing','downloading','ready','failed') NOT NULL DEFAULT 'missing',
  `local_path` VARCHAR(255) NULL COMMENT 'Extracted file or directory, relative to HPA_DATA_LOCAL_DIR',
  `download_bytes` BIGINT UNSIGNED NULL,
  `download_sha256` BINARY(32) NULL,
  `unpacked_bytes` BIGINT UNSIGNED NULL COMMENT 'Size of the extracted file or directory',
  `downloaded_unix_ms` BIGINT UNSIGNED NULL,
  `verified_unix_ms` BIGINT UNSIGNED NULL COMMENT 'Last time the local copy was checked against this row',
  `last_error` VARCHAR(512) NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hpa_datasets_catalog_id` (`catalog_id`),
  UNIQUE KEY `uq_hpa_datasets_version_file` (`hpa_version`, `file_name`),
  KEY `idx_hpa_datasets_version_status` (`hpa_version`, `local_status`, `id`),
  KEY `idx_hpa_datasets_resource` (`resource`, `id`),
  CONSTRAINT `chk_hpa_datasets_ready` CHECK (
    `local_status` <> 'ready'
    OR (`local_path` IS NOT NULL AND `download_bytes` IS NOT NULL AND `download_sha256` IS NOT NULL
        AND `unpacked_bytes` IS NOT NULL AND `downloaded_unix_ms` IS NOT NULL AND `verified_unix_ms` IS NOT NULL)
  ),
  CONSTRAINT `chk_hpa_datasets_failed` CHECK (`local_status` <> 'failed' OR `last_error` IS NOT NULL),
  CONSTRAINT `chk_hpa_datasets_time_order` CHECK (`updated_unix_ms` >= `created_unix_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

SET @atlasai_seed_unix_ms = CAST(
  FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)
  AS UNSIGNED
);

INSERT INTO `atlasai`.`inference_providers` (
  `provider_key`,
  `display_name`,
  `adapter_key`,
  `api_base_url`,
  `credential_env_key`,
  `status`,
  `created_unix_ms`,
  `updated_unix_ms`
) VALUES
  (
    'openai',
    'OpenAI',
    'openai_chat_completions',
    'https://api.openai.com/v1',
    'OPENAI_API_KEY',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  (
    'gemini',
    'Google Gemini',
    'openai_chat_completions',
    'https://generativelanguage.googleapis.com/v1beta/openai/',
    'GEMINI_API_KEY',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  (
    'glm',
    'Z.ai GLM',
    'openai_chat_completions',
    'https://open.bigmodel.cn/api/paas/v4/',
    'GLM_API_KEY',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  (
    'groq',
    'GroqCloud',
    'openai_chat_completions',
    'https://api.groq.com/openai/v1',
    'GROQ_API_KEY',
    'disabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  (
    'anthropic',
    'Anthropic',
    'anthropic_messages',
    'https://api.anthropic.com',
    'ANTHROPIC_API_KEY',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  -- Claude and Gemini reached through a Google Cloud project instead of a vendor API key. Requests
  -- are signed with Google Application Default Credentials, so credential_env_key names the service
  -- account file rather than a key and the gateway does not require it to be set; on a Google VM
  -- the metadata server supplies the credentials instead. The location lives in the API base URL:
  -- 'aiplatform.googleapis.com' is the global endpoint, 'aiplatform.eu.rep.googleapis.com' is the
  -- EU multi-region, and a single region looks like 'europe-west1-aiplatform.googleapis.com'.
  -- Both providers are enabled but hold no active model, so nothing reaches Google until one of
  -- their models is made active. Set GOOGLE_CLOUD_PROJECT first.
  (
    'anthropic-vertex',
    'Anthropic on Google Vertex AI',
    'anthropic_vertex',
    'https://aiplatform.googleapis.com',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  (
    'gemini-vertex',
    'Google Gemini on Vertex AI',
    'gemini_vertex',
    'https://aiplatform.googleapis.com',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  (
    'alibaba',
    'Alibaba Model Studio (DashScope intl)',
    'openai_chat_completions',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'ALIBABA_API_KEY',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  ),
  (
    'deepseek',
    'DeepSeek',
    'openai_chat_completions',
    'https://api.deepseek.com/v1',
    'DEEPSEEK_API_KEY',
    'enabled',
    @atlasai_seed_unix_ms,
    @atlasai_seed_unix_ms
  );

INSERT INTO `atlasai`.`inference_models` (
  `provider_id`,
  `config_key`,
  `model_id`,
  `display_name`,
  `status`,
  `supports_streaming`,
  `supports_tools`,
  `supports_json_mode`,
  `supports_tool_role_messages`,
  `supports_vision`,
  `supports_reasoning`,
  `catalog_verified_unix_ms`,
  `created_unix_ms`,
  `updated_unix_ms`
) VALUES
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini-2025-04-14', 'GPT-4.1 mini (2025-04-14)', 'active',   1, 1, 1, 1, 1, 0, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-4.1-2025-04-14',      'gpt-4.1-2025-04-14',      'GPT-4.1 (2025-04-14)',      'inactive', 1, 1, 1, 1, 1, 0, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-4.1-nano-2025-04-14', 'gpt-4.1-nano-2025-04-14', 'GPT-4.1 nano (2025-04-14)', 'inactive', 1, 1, 1, 1, 1, 0, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'gemini'), 'gemini-3.7-flash',               'gemini-3.7-flash',          'Gemini 3.7 Flash',           'inactive', 1, 1, 1, 0, 1, 1, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'gemini'), 'gemini-3.5-flash',               'gemini-3.5-flash',          'Gemini 3.5 Flash',           'inactive', 1, 1, 1, 0, 1, 1, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'gemini'), 'gemini-3.1-pro-preview',         'gemini-3.1-pro-preview',    'Gemini 3.1 Pro Preview',     'inactive', 1, 1, 1, 0, 1, 1, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'glm'),    'glm-5.2',                         'glm-5.2',                   'GLM-5.2',                    'inactive', 1, 1, 1, 1, 0, 1, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'glm'),    'glm-5',                           'glm-5',                     'GLM-5',                      'inactive', 1, 1, 1, 1, 0, 1, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'glm'),    'glm-4.7',                         'glm-4.7',                   'GLM-4.7',                    'inactive', 1, 1, 1, 1, 0, 1, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms);

INSERT INTO `atlasai`.`inference_models` (
  `provider_id`,
  `config_key`,
  `model_id`,
  `display_name`,
  `status`,
  `supports_streaming`,
  `supports_tools`,
  `supports_json_mode`,
  `supports_tool_role_messages`,
  `supports_vision`,
  `supports_reasoning`,
  `max_context_tokens`,
  `max_output_tokens`,
  `default_output_tokens`,
  `input_price_microusd_per_million_tokens`,
  `output_price_microusd_per_million_tokens`,
  `price_verified_unix_ms`,
  `catalog_verified_unix_ms`,
  `created_unix_ms`,
  `updated_unix_ms`
) VALUES
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-gpt-oss-120b',       'openai/gpt-oss-120b',              'Groq GPT-OSS 120B',    'inactive', 1, 1, 1, 1, 0, 1, 131072,  65536, 8192,  150000,   600000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-gpt-oss-20b',        'openai/gpt-oss-20b',               'Groq GPT-OSS 20B',     'inactive', 1, 1, 1, 1, 0, 1, 131072,  65536, 8192,   75000,   300000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-qwen-3.6-27b',       'qwen/qwen3.6-27b',                 'Qwen 3.6 27B (Preview)','inactive', 1, 1, 1, 1, 1, 1, 131072,  16384, 8192,  600000,  3000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-qwen-3.8-27b',       'qwen/qwen3.8-27b',                 'Qwen 3.8 27B (Preview)','inactive', 1, 1, 1, 1, 1, 1, 131042,  16384, 8192,  800000,  4000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic'), 'anthropic-claude-opus-5',  'claude-opus-5',                      'Claude Opus 5',         'inactive', 1, 1, 1, 1, 1, 1, 1000000, 128000, 8192, 5000000, 25000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic'), 'anthropic-claude-sonnet-5','claude-sonnet-5',                    'Claude Sonnet 5',       'inactive', 1, 1, 1, 1, 1, 1, 1000000, 128000, 8192, 2000000, 10000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic'), 'anthropic-claude-haiku-4-5','claude-haiku-4-5-20251001',          'Claude Haiku 4.5',      'inactive', 1, 1, 1, 1, 1, 1,  200000,  64000, 8192, 1000000,  5000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms);

-- The same models reached through a Google Cloud project instead. Vertex model ids are not always
-- the first-party ids: a dated snapshot separates the date with '@'. Prices are left unset because
-- Vertex is billed by Google at its own rates
-- (https://cloud.google.com/vertex-ai/generative-ai/pricing); fill them in per installation.
INSERT INTO `atlasai`.`inference_models` (
  `provider_id`,
  `config_key`,
  `model_id`,
  `display_name`,
  `status`,
  `supports_streaming`,
  `supports_tools`,
  `supports_json_mode`,
  `supports_tool_role_messages`,
  `supports_vision`,
  `supports_reasoning`,
  `reasoning_effort`,
  `max_context_tokens`,
  `max_output_tokens`,
  `default_output_tokens`,
  `catalog_verified_unix_ms`,
  `created_unix_ms`,
  `updated_unix_ms`
) VALUES
  -- Model ids and context windows are the ones published for Agent Platform at
  -- https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai (read 2026-09-22).
  -- A dated snapshot separates its date with '@'; the newer models are plain aliases. Deprecated
  -- models (Opus 4.1, Opus 4, Sonnet 4, Haiku 3.5) are deliberately left out.
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-fable-5-1', 'claude-fable-5-1',          'Claude Fable 5.1 (Vertex)', 'inactive', 1, 1, 1, 1, 1, 1, NULL,  1000000, 128000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-opus-5',    'claude-opus-5',             'Claude Opus 5 (Vertex)',    'inactive', 1, 1, 1, 1, 1, 1, NULL,  1000000, 128000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-opus-4-8',  'claude-opus-4-8',           'Claude Opus 4.8 (Vertex)',  'inactive', 1, 1, 1, 1, 1, 1, NULL,  1000000, 128000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-opus-4-7',  'claude-opus-4-7',           'Claude Opus 4.7 (Vertex)',  'inactive', 1, 1, 1, 1, 1, 1, NULL,  1000000, 128000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-opus-4-6',  'claude-opus-4-6',           'Claude Opus 4.6 (Vertex)',  'inactive', 1, 1, 1, 1, 1, 1, NULL,  1000000, 128000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-sonnet-5',  'claude-sonnet-5',           'Claude Sonnet 5 (Vertex)',  'inactive', 1, 1, 1, 1, 1, 1, NULL,  1000000, 128000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-sonnet-4-6','claude-sonnet-4-6',         'Claude Sonnet 4.6 (Vertex)','inactive', 1, 1, 1, 1, 1, 1, NULL,  1000000, 128000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-opus-4-5',  'claude-opus-4-5@20251101',  'Claude Opus 4.5 (Vertex)',  'inactive', 1, 1, 1, 1, 1, 1, NULL,   200000,  64000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-sonnet-4-5','claude-sonnet-4-5@20250929','Claude Sonnet 4.5 (Vertex)','inactive', 1, 1, 1, 1, 1, 1, NULL,   200000,  64000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic-vertex'), 'vertex-claude-haiku-4-5', 'claude-haiku-4-5@20251001', 'Claude Haiku 4.5 (Vertex)', 'inactive', 1, 1, 1, 1, 1, 1, NULL,   200000,  64000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  -- Gemini through the same Google Cloud project. Low thinking throughout, matching the Gemini
  -- rows on the AI Studio provider.
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'gemini-vertex'),    'vertex-gemini-3.8-flash',     'gemini-3.8-flash',      'Gemini 3.8 Flash (Vertex)',     'inactive', 1, 1, 1, 0, 1, 1, 'low', 1000000, 65536, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'gemini-vertex'),    'vertex-gemini-3.7-flash',     'gemini-3.7-flash',      'Gemini 3.7 Flash (Vertex)',     'inactive', 1, 1, 1, 0, 1, 1, 'low', 1000000, 65536, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'gemini-vertex'),    'vertex-gemini-3.6-flash',     'gemini-3.6-flash',      'Gemini 3.6 Flash (Vertex)',     'inactive', 1, 1, 1, 0, 1, 1, 'low', 1000000, 65536, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'gemini-vertex'),    'vertex-gemini-3.5-flash-lite','gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (Vertex)','inactive', 1, 1, 1, 0, 1, 1, 'low', 1000000, 65536, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms);

-- Open-weight models served through Alibaba Model Studio (international endpoint) and
-- DeepSeek's own API. Model IDs were taken from each provider's live /models listing on
-- 2026-09-01; context/output limits are NULL where the provider does not publish them.
INSERT INTO `atlasai`.`inference_models` (
  `provider_id`,
  `config_key`,
  `model_id`,
  `display_name`,
  `status`,
  `supports_streaming`,
  `supports_tools`,
  `supports_json_mode`,
  `supports_tool_role_messages`,
  `supports_vision`,
  `supports_reasoning`,
  `max_context_tokens`,
  `max_output_tokens`,
  `default_output_tokens`,
  `catalog_verified_unix_ms`,
  `created_unix_ms`,
  `updated_unix_ms`
) VALUES
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'alibaba'),  'alibaba-qwen3.8-27b',       'qwen3.8-27b',       'Qwen 3.8 27B (Alibaba)',        'inactive', 1, 1, 1, 1, 0, 1,    NULL,   NULL, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'alibaba'),  'alibaba-qwen3.8-2.4t-a95b', 'qwen3.8-2.4t-a95b', 'Qwen 3.8 2.4T-A95B (Alibaba)',  'inactive', 1, 1, 1, 1, 0, 1,    NULL,   NULL, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'alibaba'),  'alibaba-qwen3.5-397b-a17b', 'qwen3.5-397b-a17b', 'Qwen 3.5 397B-A17B (Alibaba)',  'inactive', 1, 1, 1, 1, 0, 1,    NULL,   NULL, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'alibaba'),  'alibaba-qwen3.8-flash',     'qwen3.8-flash',     'Qwen 3.8 Flash (Alibaba)',      'inactive', 1, 1, 1, 1, 0, 1,    NULL,   NULL, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  -- The bare 'deepseek-v4-pro' alias on DashScope intl never answered (90 s, every request shape) on 2026-09-01; the dated snapshot does.
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'alibaba'),  'alibaba-deepseek-v4-pro',   'deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813 (Alibaba)', 'inactive', 1, 1, 1, 1, 0, 1, NULL, NULL, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'alibaba'),  'alibaba-deepseek-v4-flash', 'deepseek-v4-flash', 'DeepSeek V4 Flash (Alibaba)',   'inactive', 1, 1, 1, 1, 0, 1,    NULL,   NULL, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'alibaba'),  'alibaba-kimi-k3',           'kimi-k3',           'Kimi K3 (Alibaba)',             'inactive', 1, 1, 1, 1, 0, 1,    NULL,   NULL, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'deepseek'), 'deepseek-v4-pro',           'deepseek-v4-pro',   'DeepSeek V4 Pro',               'inactive', 1, 1, 1, 1, 0, 1, 1000000, 384000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'deepseek'), 'deepseek-v4-flash',         'deepseek-v4-flash', 'DeepSeek V4 Flash',             'inactive', 1, 1, 1, 1, 0, 1, 1000000, 384000, 8192, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms);

-- GPT-5 family. On /v1/chat/completions the GPT-5.6 models accept function tools only with
-- reasoning_effort 'none' (verified 2026-09-01), so those rows run without reasoning.
INSERT INTO `atlasai`.`inference_models` (
  `provider_id`,
  `config_key`,
  `model_id`,
  `display_name`,
  `status`,
  `supports_streaming`,
  `supports_tools`,
  `supports_json_mode`,
  `supports_tool_role_messages`,
  `supports_vision`,
  `supports_reasoning`,
  `reasoning_effort`,
  `catalog_verified_unix_ms`,
  `created_unix_ms`,
  `updated_unix_ms`
) VALUES
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-5.6-luna',  'gpt-5.6-luna',            'GPT-5.6 Luna',              'inactive', 1, 1, 1, 1, 1, 1, 'none', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-5.6-sol',   'gpt-5.6-sol',             'GPT-5.6 Sol',               'inactive', 1, 1, 1, 1, 1, 1, 'none', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-5.6-terra', 'gpt-5.6-terra',           'GPT-5.6 Terra',             'inactive', 1, 1, 1, 1, 1, 1, 'none', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-5.4-mini',  'gpt-5.4-mini-2026-03-17', 'GPT-5.4 mini (2026-03-17)', 'inactive', 1, 1, 1, 1, 1, 1, NULL,   @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'openai'), 'openai-gpt-5.4-nano',  'gpt-5.4-nano-2026-03-17', 'GPT-5.4 nano (2026-03-17)', 'inactive', 1, 1, 1, 1, 1, 1, NULL,   @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms);

-- List prices verified 2026-09-02 (USD per million tokens x 1e6) and the visitor picker allow-list.
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 2000000, `cached_input_price_microusd_per_million_tokens` = 500000, `output_price_microusd_per_million_tokens` = 8000000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-4.1-2025-04-14';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 400000, `cached_input_price_microusd_per_million_tokens` = 100000, `output_price_microusd_per_million_tokens` = 1600000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-4.1-mini-2025-04-14';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 100000, `cached_input_price_microusd_per_million_tokens` = 25000, `output_price_microusd_per_million_tokens` = 400000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-4.1-nano-2025-04-14';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 200000, `cached_input_price_microusd_per_million_tokens` = 20000, `output_price_microusd_per_million_tokens` = 1200000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-5.6-luna';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 4000000, `cached_input_price_microusd_per_million_tokens` = 400000, `output_price_microusd_per_million_tokens` = 20000000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-5.6-sol';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 2000000, `cached_input_price_microusd_per_million_tokens` = 200000, `output_price_microusd_per_million_tokens` = 12000000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-5.6-terra';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 750000, `cached_input_price_microusd_per_million_tokens` = 75000, `output_price_microusd_per_million_tokens` = 4500000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-5.4-mini';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 200000, `cached_input_price_microusd_per_million_tokens` = 20000, `output_price_microusd_per_million_tokens` = 1250000, `price_source_url` = 'https://developers.openai.com/api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'openai-gpt-5.4-nano';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 750000, `cached_input_price_microusd_per_million_tokens` = 75000, `output_price_microusd_per_million_tokens` = 3750000, `price_source_url` = 'https://ai.google.dev/gemini-api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'gemini-3.7-flash';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 1500000, `cached_input_price_microusd_per_million_tokens` = 150000, `output_price_microusd_per_million_tokens` = 9000000, `price_source_url` = 'https://ai.google.dev/gemini-api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'gemini-3.5-flash';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 2000000, `cached_input_price_microusd_per_million_tokens` = 200000, `output_price_microusd_per_million_tokens` = 12000000, `price_source_url` = 'https://ai.google.dev/gemini-api/docs/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'gemini-3.1-pro-preview';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 1400000, `cached_input_price_microusd_per_million_tokens` = 260000, `output_price_microusd_per_million_tokens` = 4400000, `price_source_url` = 'https://docs.z.ai/guides/overview/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'glm-5.2';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 1000000, `cached_input_price_microusd_per_million_tokens` = 200000, `output_price_microusd_per_million_tokens` = 3200000, `price_source_url` = 'https://docs.z.ai/guides/overview/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'glm-5';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 600000, `cached_input_price_microusd_per_million_tokens` = 110000, `output_price_microusd_per_million_tokens` = 2200000, `price_source_url` = 'https://docs.z.ai/guides/overview/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'glm-4.7';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 150000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 600000, `price_source_url` = 'https://groq.com/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 0, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'groq-gpt-oss-120b';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 75000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 300000, `price_source_url` = 'https://groq.com/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 0, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'groq-gpt-oss-20b';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 600000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 3000000, `price_source_url` = 'https://groq.com/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 0, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'groq-qwen-3.6-27b';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 800000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 4000000, `price_source_url` = 'https://groq.com/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 0, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'groq-qwen-3.8-27b';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 5000000, `cached_input_price_microusd_per_million_tokens` = 500000, `output_price_microusd_per_million_tokens` = 25000000, `price_source_url` = 'https://www.anthropic.com/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'anthropic-claude-opus-5';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 2000000, `cached_input_price_microusd_per_million_tokens` = 200000, `output_price_microusd_per_million_tokens` = 10000000, `price_source_url` = 'https://www.anthropic.com/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'anthropic-claude-sonnet-5';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 1000000, `cached_input_price_microusd_per_million_tokens` = 100000, `output_price_microusd_per_million_tokens` = 5000000, `price_source_url` = 'https://www.anthropic.com/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'anthropic-claude-haiku-4-5';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 500000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 3000000, `price_source_url` = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'alibaba-qwen3.8-27b';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 2000000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 6000000, `price_source_url` = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'alibaba-qwen3.8-2.4t-a95b';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 600000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 3600000, `price_source_url` = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'alibaba-qwen3.5-397b-a17b';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 150000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 470000, `price_source_url` = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'alibaba-qwen3.8-flash';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 1320000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 3960000, `price_source_url` = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'alibaba-deepseek-v4-pro';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 200000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 400000, `price_source_url` = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'alibaba-deepseek-v4-flash';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 3000000, `cached_input_price_microusd_per_million_tokens` = NULL, `output_price_microusd_per_million_tokens` = 15000000, `price_source_url` = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'alibaba-kimi-k3';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 1320000, `cached_input_price_microusd_per_million_tokens` = 44000, `output_price_microusd_per_million_tokens` = 3960000, `price_source_url` = 'https://api-docs.deepseek.com/quick_start/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'deepseek-v4-pro';
UPDATE `atlasai`.`inference_models` SET `input_price_microusd_per_million_tokens` = 440000, `cached_input_price_microusd_per_million_tokens` = 14000, `output_price_microusd_per_million_tokens` = 1320000, `price_source_url` = 'https://api-docs.deepseek.com/quick_start/pricing', `price_verified_unix_ms` = @atlasai_seed_unix_ms, `visitor_selectable` = 1, `updated_unix_ms` = @atlasai_seed_unix_ms, `revision` = `revision` + 1 WHERE `config_key` = 'deepseek-v4-flash';

-- The single active platform policy. Limits are NULL when not enforced; edit in place or insert a new row and flip status.
INSERT INTO `atlasai`.`platform_config` (
  `label`, `status`, `active_hpa_version`, `offline_agents_enabled`, `budget_window_mode`,
  `platform_budget_usd_per_day`, `platform_budget_usd_per_week`, `platform_budget_usd_per_month`,
  `over_budget_behaviour`, `fallback_inference_model_id`, `unpriced_model_behaviour`,
  `visitor_budget_usd_per_day`, `visitor_budget_usd_per_week`, `visitor_budget_usd_per_month`,
  `visitor_requests_per_minute`, `visitor_requests_per_hour`, `visitor_requests_per_day`,
  `visitor_tokens_per_day`, `visitor_runs_per_day`, `visitor_aso_runs_per_day`, `visitor_concurrent_runs`,
  `visitor_batch_queries_per_day`, `global_requests_per_minute`, `global_concurrent_runs`,
  `visitor_model_selection_enabled`, `visitor_provider_keys_enabled`,
  `visitor_keys_bypass_spend_limits`, `visitor_keys_bypass_volume_limits`,
  `query_max_characters`, `model_history_messages`, `batch_max_queries`, `batch_concurrency`,
  `deep_research_max_retries`, `aso_max_steps`, `aso_parallel_limit`, `aso_top_x`,
  `created_unix_ms`, `updated_unix_ms`
) VALUES (
  'Production defaults', 'active', '25.1', 1, 'rolling',
  25.00, 100.00, 300.00,
  'block', NULL, 'allow',
  5.00, 20.00, 50.00,
  20, 200, 1000,
  5000000, 200, 50, 3,
  500, 120, 12,
  1, 1,
  1, 0,
  20000, 100, 50, 2,
  2, 20, 3, 0,
  @atlasai_seed_unix_ms, @atlasai_seed_unix_ms
);

-- HPA bulk download catalog (sheet 'Current bulk files', checked 2026-09-01). The HPA team adds rows for a
-- new release and switches platform_config.active_hpa_version; the deployment then syncs the files.
INSERT INTO `atlasai`.`hpa_datasets` (
  `catalog_id`, `hpa_version`, `resource`, `dataset_name`, `description`, `file_role`, `file_name`, `format`, `compression`, `release_unix_ms`, `download_url`, `source_page_url`, `source_section`, `link_text`, `link_verification`, `image_content_status`, `duplicate_source_pages`, `catalog_checked_unix_ms`, `notes`, `created_unix_ms`, `updated_unix_ms`
) VALUES
  (1, '25.1', 'Tissue', 'Normal tissue IHC protein expression', 'Protein expression profiles in 45 human tissues from IHC tissue microarrays, including gene, tissue, cell type, expression level and reliability.', 'Primary data', 'normal_ihc_data.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/normal_ihc_data.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Protein expression, normal tissue IHC', 'normal_ihc_data.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels; annotation table', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (2, '25.1', 'Tissue', 'Standard IHC tissue lookup', 'Standard-panel tissue names and organ groups for 45 tissues.', 'Metadata', 'normal_ihc_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/normal_ihc_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Protein expression, normal tissue IHC', 'normal_ihc_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (3, '25.1', 'Tissue', 'Standard IHC cell-type lookup', 'Annotated IHC cell types for the standard tissue panel, covering 76 cell-type entries.', 'Metadata', 'normal_ihc_cell_types.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/normal_ihc_cell_types.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Protein expression, normal tissue IHC', 'normal_ihc_cell_types.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (4, '25.1', 'Tissue', 'Additional IHC tissue lookup', 'Tissue names and organ groups for 29 additional tissues.', 'Metadata', 'normal_ihc_at_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/normal_ihc_at_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Protein expression, additional tissues', 'normal_ihc_at_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (5, '25.1', 'Tissue', 'Additional IHC cell-type lookup', 'Annotated cell types for the additional-tissue panel, covering 95 entries.', 'Metadata', 'normal_ihc_at_cell_types.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/normal_ihc_at_cell_types.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Protein expression, additional tissues', 'normal_ihc_at_cell_types.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (6, '25.1', 'Tissue', 'Extended annotation tissue lookup', 'Tissue names and organ groups for 14 extended-annotation tissues.', 'Metadata', 'normal_ihc_ea_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/normal_ihc_ea_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Protein expression, extended annotation', 'normal_ihc_ea_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (7, '25.1', 'Tissue', 'Extended annotation cell-type lookup', 'Extended annotated cell types, covering 118 entries.', 'Metadata', 'normal_ihc_ea_cell_types.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/normal_ihc_ea_cell_types.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Protein expression, extended annotation', 'normal_ihc_ea_cell_types.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (8, '25.1', 'Tissue', 'Tissue MS sample protein intensity', 'Protein intensity per sample for 60 samples across 20 tissues.', 'Primary sample-level data', 'ms_tissue_sample_data.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/ms_tissue_sample_data.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Mass spectrometry tissue proteomics', 'ms_tissue_sample_data.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (9, '25.1', 'Tissue', 'Tissue MS summarized protein intensity', 'Protein intensity summarized across 20 tissues.', 'Primary aggregate data', 'ms_tissue.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/ms_tissue.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Mass spectrometry tissue proteomics', 'ms_tissue.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (10, '25.1', 'Tissue', 'Tissue MS tissue lookup', 'Metadata for the 20 tissues represented in the tissue MS dataset.', 'Metadata', 'ms_tissue_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/ms_tissue_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Mass spectrometry tissue proteomics', 'ms_tissue_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (11, '25.1', 'Tissue', 'Consensus tissue RNA', 'Consensus gene expression across 51 tissues using the maximum normalized nTPM from HPA and GTEx.', 'Primary aggregate data', 'rna_tissue_consensus.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_consensus.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Consensus tissue RNA', 'rna_tissue_consensus.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (12, '25.1', 'Tissue', 'Consensus tissue lookup', 'Metadata for the 51 consensus tissues.', 'Metadata', 'rna_tissue_consensus_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_consensus_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'Consensus tissue RNA', 'rna_tissue_consensus_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (13, '25.1', 'Tissue', 'HPA tissue RNA', 'Gene-level HPA RNA expression across 40 tissues.', 'Primary aggregate data', 'rna_tissue_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'HPA tissue RNA', 'rna_tissue_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (14, '25.1', 'Tissue', 'HPA tissue RNA lookup', 'Metadata for the 40 HPA RNA tissues.', 'Metadata', 'rna_tissue_hpa_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_hpa_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'HPA tissue RNA', 'rna_tissue_hpa_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (15, '25.1', 'Tissue', 'HPA tissue transcript RNA', 'Transcript-level RNA expression in 186 HPA tissue samples.', 'Primary sample-level transcript data', 'transcript_rna_tissue.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/transcript_rna_tissue.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'HPA tissue RNA', 'transcript_rna_tissue.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (16, '25.1', 'Tissue', 'HPA tissue sample lookup', 'Metadata for 186 HPA tissue samples.', 'Metadata', 'rna_tissue_hpa_samples.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_hpa_samples.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'HPA tissue RNA', 'rna_tissue_hpa_samples.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (17, '25.1', 'Tissue', 'GTEx tissue RNA summary', 'GTEx gene-level expression summarized across 36 tissues.', 'Primary aggregate data', 'rna_tissue_gtex.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_gtex.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'GTEx tissue RNA', 'rna_tissue_gtex.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (18, '25.1', 'Tissue', 'GTEx tissue subtype RNA', 'GTEx gene-level expression across 46 tissue subtypes.', 'Primary detailed data', 'rna_tissue_detail_gtex.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_detail_gtex.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'GTEx tissue RNA', 'rna_tissue_detail_gtex.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (19, '25.1', 'Tissue', 'GTEx retina transcript RNA', 'Transcript-level RNA expression for 105 GTEx retina samples.', 'Primary sample-level transcript data', 'transcript_rna_gtexretina.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/transcript_rna_gtexretina.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'GTEx tissue RNA', 'transcript_rna_gtexretina.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', 'Also linked from the Brain data page', 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (20, '25.1', 'Tissue', 'GTEx tissue lookup', 'Metadata for 36 GTEx tissues.', 'Metadata', 'rna_tissue_gtex_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_gtex_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'GTEx tissue RNA', 'rna_tissue_gtex_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (21, '25.1', 'Tissue', 'GTEx subtype lookup', 'Metadata for 46 GTEx tissue subtypes.', 'Metadata', 'rna_tissue_detail_gtex_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_detail_gtex_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'GTEx tissue RNA', 'rna_tissue_detail_gtex_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (22, '25.1', 'Tissue', 'GTEx sample lookup', 'Metadata for 36,446 GTEx samples.', 'Metadata', 'rna_tissue_detail_gtex_samples.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_detail_gtex_samples.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'GTEx tissue RNA', 'rna_tissue_detail_gtex_samples.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (23, '25.1', 'Tissue', 'FANTOM tissue RNA summary', 'FANTOM5 CAGE expression summarized across 46 tissues.', 'Primary aggregate data', 'rna_tissue_fantom.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_fantom.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'FANTOM tissue RNA', 'rna_tissue_fantom.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (24, '25.1', 'Tissue', 'FANTOM tissue subtype RNA', 'FANTOM5 expression across 66 tissue subtypes.', 'Primary detailed data', 'rna_tissue_detail_fantom.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_detail_fantom.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'FANTOM tissue RNA', 'rna_tissue_detail_fantom.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (25, '25.1', 'Tissue', 'FANTOM tissue lookup', 'Metadata for 46 FANTOM tissues.', 'Metadata', 'rna_tissue_fantom_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_fantom_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'FANTOM tissue RNA', 'rna_tissue_fantom_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (26, '25.1', 'Tissue', 'FANTOM subtype lookup', 'Metadata for 66 FANTOM tissue subtypes.', 'Metadata', 'rna_tissue_detail_fantom_tissues.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_detail_fantom_tissues.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'FANTOM tissue RNA', 'rna_tissue_detail_fantom_tissues.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (27, '25.1', 'Tissue', 'FANTOM sample lookup', 'Metadata for 77 FANTOM samples.', 'Metadata', 'rna_tissue_detail_fantom_samples.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_tissue_detail_fantom_samples.tsv.zip', 'https://www.proteinatlas.org/humanproteome/tissue/data', 'FANTOM tissue RNA', 'rna_tissue_detail_fantom_samples.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (28, '25.1', 'Brain', 'HPA human brain-region RNA', 'Gene-level HPA RNA expression across 13 human brain regions.', 'Primary aggregate data', 'rna_brain_region_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_region_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Human brain regions', 'rna_brain_region_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (29, '25.1', 'Brain', 'Human brain-region lookup', 'Metadata for the 13 HPA human brain regions.', 'Metadata', 'rna_brain_region_hpa_brain_regions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_region_hpa_brain_regions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Human brain regions', 'rna_brain_region_hpa_brain_regions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (30, '25.1', 'Brain', 'HPA human brain subregion RNA', 'Gene-level HPA RNA expression across 193 human brain subregions.', 'Primary detailed data', 'rna_brain_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Human brain subregions', 'rna_brain_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (31, '25.1', 'Brain', 'Human brain subregion lookup', 'Metadata for 193 HPA human brain subregions.', 'Metadata', 'rna_brain_hpa_subregions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_hpa_subregions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Human brain subregions', 'rna_brain_hpa_subregions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (32, '25.1', 'Brain', 'Human brain transcript RNA', 'Transcript-level RNA expression in 966 human brain samples.', 'Primary sample-level transcript data', 'transcript_rna_brain.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/transcript_rna_brain.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Human brain subregions', 'transcript_rna_brain.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (33, '25.1', 'Brain', 'Prefrontal cortex RNA', 'Gene-level RNA expression across 20 human prefrontal cortex subregions.', 'Primary detailed data', 'rna_pfc_brain_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_pfc_brain_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Prefrontal cortex', 'rna_pfc_brain_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (34, '25.1', 'Brain', 'Prefrontal cortex lookup', 'Metadata for the 20 human prefrontal cortex subregions.', 'Metadata', 'rna_pfc_brain_hpa_subregions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_pfc_brain_hpa_subregions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Prefrontal cortex', 'rna_pfc_brain_hpa_subregions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (35, '25.1', 'Brain', 'Prefrontal cortex transcript RNA', 'Transcript-level RNA expression in 165 prefrontal cortex samples.', 'Primary sample-level transcript data', 'transcript_rna_pfcbrain.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/transcript_rna_pfcbrain.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Prefrontal cortex', 'transcript_rna_pfcbrain.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (36, '25.1', 'Brain', 'GTEx brain RNA', 'GTEx gene-level RNA expression across 8 brain regions.', 'Primary aggregate data', 'rna_brain_gtex.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_gtex.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'GTEx brain', 'rna_brain_gtex.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (37, '25.1', 'Brain', 'GTEx brain-region lookup', 'Metadata for 8 GTEx brain regions.', 'Metadata', 'rna_brain_gtex_brain_regions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_gtex_brain_regions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'GTEx brain', 'rna_brain_gtex_brain_regions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (38, '25.1', 'Brain', 'FANTOM brain RNA', 'FANTOM gene-level RNA expression across 12 brain regions.', 'Primary aggregate data', 'rna_brain_fantom.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_fantom.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'FANTOM brain', 'rna_brain_fantom.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (39, '25.1', 'Brain', 'FANTOM brain-region lookup', 'Metadata for 12 FANTOM brain regions.', 'Metadata', 'rna_brain_fantom_brain_regions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_brain_fantom_brain_regions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'FANTOM brain', 'rna_brain_fantom_brain_regions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (40, '25.1', 'Brain', 'Pig brain-region RNA', 'Pig gene-level RNA expression across 13 brain regions.', 'Primary aggregate data', 'rna_pig_brain_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_pig_brain_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Pig brain', 'rna_pig_brain_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (41, '25.1', 'Brain', 'Pig brain-region lookup', 'Metadata for 13 pig brain regions.', 'Metadata', 'rna_pig_brain_hpa_brain_regions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_pig_brain_hpa_brain_regions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Pig brain', 'rna_pig_brain_hpa_brain_regions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (42, '25.1', 'Brain', 'Pig brain sample RNA', 'Pig gene-level RNA expression across 30 subregions and 144 samples.', 'Primary sample-level data', 'rna_pig_brain_sample_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_pig_brain_sample_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Pig brain', 'rna_pig_brain_sample_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (43, '25.1', 'Brain', 'Pig brain subregion lookup', 'Metadata for 30 pig brain subregions.', 'Metadata', 'rna_pig_brain_subregion_hpa_subregions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_pig_brain_subregion_hpa_subregions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Pig brain', 'rna_pig_brain_subregion_hpa_subregions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (44, '25.1', 'Brain', 'Pig brain sample lookup', 'Metadata for 144 pig brain samples.', 'Metadata', 'rna_pig_brain_sample_hpa_samples.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_pig_brain_sample_hpa_samples.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Pig brain', 'rna_pig_brain_sample_hpa_samples.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (45, '25.1', 'Brain', 'Pig brain transcript RNA', 'Pig transcript-level RNA expression in 144 samples.', 'Primary sample-level transcript data', 'transcript_rna_pigbrain.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/transcript_rna_pigbrain.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Pig brain', 'transcript_rna_pigbrain.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (46, '25.1', 'Brain', 'Mouse brain-region RNA', 'Mouse gene-level RNA expression across 11 regions.', 'Primary aggregate data', 'rna_mouse_brain_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_mouse_brain_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Mouse brain', 'rna_mouse_brain_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (47, '25.1', 'Brain', 'Mouse brain-region lookup', 'Metadata for 11 mouse brain regions.', 'Metadata', 'rna_mouse_brain_hpa_brain_regions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_mouse_brain_hpa_brain_regions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Mouse brain', 'rna_mouse_brain_hpa_brain_regions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (48, '25.1', 'Brain', 'Mouse brain sample RNA', 'Mouse gene-level RNA expression across 17 subregions and 75 samples.', 'Primary sample-level data', 'rna_mouse_brain_sample_hpa.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_mouse_brain_sample_hpa.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Mouse brain', 'rna_mouse_brain_sample_hpa.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (49, '25.1', 'Brain', 'Mouse brain subregion lookup', 'Metadata for 17 mouse brain subregions.', 'Metadata', 'rna_mouse_brain_subregion_hpa_subregions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_mouse_brain_subregion_hpa_subregions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Mouse brain', 'rna_mouse_brain_subregion_hpa_subregions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (50, '25.1', 'Brain', 'Mouse brain sample lookup', 'Metadata for 75 mouse brain samples.', 'Metadata', 'rna_mouse_brain_sample_hpa_samples.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_mouse_brain_sample_hpa_samples.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Mouse brain', 'rna_mouse_brain_sample_hpa_samples.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (51, '25.1', 'Brain', 'Mouse brain transcript RNA', 'Mouse transcript-level RNA expression in 75 samples.', 'Primary sample-level transcript data', 'transcript_rna_mousebrain.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/transcript_rna_mousebrain.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Mouse brain', 'transcript_rna_mousebrain.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (52, '25.1', 'Brain', 'Allen mouse-brain expression', 'Allen Mouse Brain Atlas gene expression energy across 10 regions.', 'Primary aggregate data', 'rna_mouse_brain_allen.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_mouse_brain_allen.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Allen mouse brain', 'rna_mouse_brain_allen.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (53, '25.1', 'Brain', 'Allen mouse brain-region lookup', 'Metadata for 10 Allen mouse brain regions.', 'Metadata', 'rna_mouse_brain_allen_brain_regions.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_mouse_brain_allen_brain_regions.tsv.zip', 'https://www.proteinatlas.org/humanproteome/brain/data', 'Allen mouse brain', 'rna_mouse_brain_allen_brain_regions.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (54, '25.1', 'Single Cell Type', 'Raw single-cell read counts', 'Archive with one folder for each of 36 datasets, containing a count matrix and per-cell metadata.', 'Raw primary data', 'rna_single_cell_read_count.zip', 'Archive', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_read_count.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Single-cell datasets', 'rna_single_cell_read_count.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (55, '25.1', 'Single Cell Type', 'Single-cell dataset lookup', 'Metadata for 36 tissue datasets used in the single-cell resource.', 'Metadata', 'rna_single_cell_datasets.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_datasets.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Single-cell datasets', 'rna_single_cell_datasets.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (56, '25.1', 'Single Cell Type', 'Single-cell type-group RNA', 'Gene expression across 53 cell-type groups derived from 36 datasets.', 'Primary aggregate data', 'rna_single_cell_type_group.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_type_group.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Cell-type groups', 'rna_single_cell_type.group.tsv.zip', 'Actual href audited; the visible label differs from the download target.', 'No image pixels', NULL, 1788220800000, 'The visible label contains a dot, but the actual href uses an underscore.', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (57, '25.1', 'Single Cell Type', 'Single-cell type-group lookup', 'Metadata for 53 cell-type groups.', 'Metadata', 'rna_single_cell_type_group_cell_type_groups.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_type_group_cell_type_groups.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Cell-type groups', 'rna_single_cell_type_group_cell_type_groups.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (58, '25.1', 'Single Cell Type', 'Single-cell type RNA', 'Gene expression across 154 cell types.', 'Primary aggregate data', 'rna_single_cell_type.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_type.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Cell types', 'rna_single_cell_type.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (59, '25.1', 'Single Cell Type', 'Single-cell type lookup', 'Metadata for 154 cell types.', 'Metadata', 'rna_single_cell_type_cell_types.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_type_cell_types.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Cell types', 'rna_single_cell_type_cell_types.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (60, '25.1', 'Single Cell Type', 'Single-cell cluster RNA', 'Gene expression and read-count summaries across single-cell clusters.', 'Primary cluster-level data', 'rna_single_cell_cluster.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_cluster.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Clusters', 'rna_single_cell_cluster.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (61, '25.1', 'Single Cell Type', 'Single-cell cluster lookup', 'Metadata for 1,175 clusters.', 'Metadata', 'rna_single_cell_clusters.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_cell_clusters.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bcell%2Btype/data', 'Clusters', 'rna_single_cell_clusters.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (62, '25.1', 'Deep Visual Proteomics', 'DVP cell-type protein intensity', 'Protein intensity per gene across 27 cell types from 14 tissues.', 'Primary aggregate data', 'dvp_cell_type.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/dvp_cell_type.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/dvp/data', 'DVP cell types', 'dvp_cell_type.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (63, '25.1', 'Deep Visual Proteomics', 'DVP cell-type lookup', 'Metadata for 27 DVP cell types.', 'Metadata', 'dvp_cell_types.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/dvp_cell_types.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/dvp/data', 'DVP cell types', 'dvp_cell_types.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (64, '25.1', 'Deep Visual Proteomics', 'DVP cell-type-group data', 'Protein intensities with matched RNA nCPM across 24 cell-type groups.', 'Primary integrated data', 'dvp_cell_type_group_data.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/dvp_cell_type_group_data.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/dvp/data', 'DVP cell-type groups', 'dvp_cell_type_group_data.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (65, '25.1', 'Deep Visual Proteomics', 'DVP cell-type-group lookup', 'Metadata for 24 DVP cell-type groups.', 'Metadata', 'dvp_cell_type_group_cell_type_groups.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/dvp_cell_type_group_cell_type_groups.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/dvp/data', 'DVP cell-type groups', 'dvp_cell_type_group_cell_type_groups.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (66, '25.1', 'Deep Visual Proteomics', 'DVP sample protein intensity', 'Protein intensity per sample for 27 cell types from 14 tissues.', 'Primary sample-level data', 'dvp_sample_data.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/dvp_sample_data.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/dvp/data', 'DVP samples', 'dvp_sample_data.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (67, '25.1', 'Single Nuclei Brain', 'Single-nuclei brain dataset lookup', 'Metadata for 11 human brain regions.', 'Metadata', 'rna_single_nuclei_brain_datasets.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_nuclei_brain_datasets.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bnuclei%2Bbrain/data', 'Datasets', 'rna_single_nuclei_brain_datasets.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (68, '25.1', 'Single Nuclei Brain', 'Single-nuclei cluster-type RNA', 'Gene expression across 34 cluster types.', 'Primary aggregate data', 'rna_single_nuclei_cluster_type.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_nuclei_cluster_type.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bnuclei%2Bbrain/data', 'Cluster types', 'rna_single_nuclei_cluster_type.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (69, '25.1', 'Single Nuclei Brain', 'Single-nuclei cluster-type lookup', 'Metadata for 34 cluster types.', 'Metadata', 'rna_single_nuclei_cluster_type_cluster_types.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_nuclei_cluster_type_cluster_types.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bnuclei%2Bbrain/data', 'Cluster types', 'rna_single_nuclei_cluster_type_cluster_types.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (70, '25.1', 'Single Nuclei Brain', 'Single-nuclei brain cluster RNA', 'Gene expression and read-count summaries across 260 clusters.', 'Primary cluster-level data', 'rna_single_nuclei_brain_cluster.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_nuclei_brain_cluster.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bnuclei%2Bbrain/data', 'Clusters', 'rna_single_nuclei_brain_cluster.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (71, '25.1', 'Single Nuclei Brain', 'Single-nuclei brain cluster lookup', 'Metadata for 260 clusters.', 'Metadata', 'rna_single_nuclei_brain_clusters.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_single_nuclei_brain_clusters.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/single%2Bnuclei%2Bbrain/data', 'Clusters', 'rna_single_nuclei_brain_clusters.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, 'The page does not expose a separate raw per-cell count archive.', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (72, '25.1', 'Immune Cell', 'HPA immune-cell RNA', 'Gene-level RNA expression across 18 immune cell types plus PBMC.', 'Primary aggregate data', 'rna_immune_cell.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'HPA immune cells', 'rna_immune_cell.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (73, '25.1', 'Immune Cell', 'HPA immune-cell lookup', 'Metadata for 19 immune-cell categories.', 'Metadata', 'rna_immune_cell_immune_cells.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell_immune_cells.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'HPA immune cells', 'rna_immune_cell_immune_cells.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (74, '25.1', 'Immune Cell', 'HPA immune-cell sample RNA', 'Gene-level RNA expression across 109 immune-cell samples.', 'Primary sample-level data', 'rna_immune_cell_sample.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell_sample.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'HPA immune-cell samples', 'rna_immune_cell_sample.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (75, '25.1', 'Immune Cell', 'HPA immune-cell sample lookup', 'Metadata for 109 immune-cell samples.', 'Metadata', 'rna_immune_cell_samples.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell_samples.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'HPA immune-cell samples', 'rna_immune_cell_samples.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (76, '25.1', 'Immune Cell', 'HPA immune-cell transcript RNA', 'Transcript-level RNA expression across 109 immune-cell samples.', 'Primary sample-level transcript data', 'transcript_rna_immunecells.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/transcript_rna_immunecells.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'HPA immune-cell samples', 'transcript_rna_immunecells.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (77, '24.0', 'Immune Cell', 'Schmiedel immune-cell RNA', 'Schmiedel expression data across 15 immune-cell types.', 'External integrated data', 'rna_immune_cell_schmiedel.tsv.zip', 'TSV', 'ZIP', 1729555200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell_schmiedel.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'Schmiedel immune cells', 'rna_immune_cell_schmiedel.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (78, '24.0', 'Immune Cell', 'Schmiedel immune-cell lookup', 'Metadata for the 15 Schmiedel immune-cell types.', 'Metadata', 'rna_immune_cell_schmiedel_immune_cells.tsv.zip', 'TSV', 'ZIP', 1729555200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell_schmiedel_immune_cells.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'Schmiedel immune cells', 'rna_immune_cell_schmiedel_immune_cells.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (79, '24.0', 'Immune Cell', 'Monaco immune-cell RNA', 'Monaco expression data across 30 immune-cell types.', 'External integrated data', 'rna_immune_cell_monaco.tsv.zip', 'TSV', 'ZIP', 1729555200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell_monaco.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'Monaco immune cells', 'rna_immune_cell_monaco.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (80, '24.0', 'Immune Cell', 'Monaco immune-cell lookup', 'Metadata for the 30 Monaco immune-cell types.', 'Metadata', 'rna_immune_cell_monaco_immune_cells.tsv.zip', 'TSV', 'ZIP', 1729555200000, 'https://www.proteinatlas.org/download/tsv/rna_immune_cell_monaco_immune_cells.tsv.zip', 'https://www.proteinatlas.org/humanproteome/single%2Bcell/immune%2Bcell/data', 'Monaco immune cells', 'rna_immune_cell_monaco_immune_cells.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (81, '25.1', 'Subcellular', 'Subcellular protein localization', 'Gene-level subcellular localization annotations and reliability information.', 'Primary annotation data', 'subcellular_location.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/subcellular_location.tsv.zip', 'https://www.proteinatlas.org/humanproteome/subcellular/data', 'Protein locations', 'subcellular_location.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (82, '25.1', 'Subcellular', 'Subcellular location lookup', 'Metadata for 49 subcellular locations.', 'Metadata', 'subcellular_locations.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/subcellular_locations.tsv.zip', 'https://www.proteinatlas.org/humanproteome/subcellular/data', 'Protein locations', 'subcellular_locations.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (83, '25.1', 'Subcellular', 'SubCell embeddings', 'PyTorch metadata, predictions and embedding features for segmented cells. The archive contains derived numeric features, not microscopy pixels.', 'Image-derived feature data', 'subcell_embeddings.zip', 'Archive', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/subcell_embeddings.zip', 'https://www.proteinatlas.org/humanproteome/subcellular/data', 'SubCell embeddings', 'subcell_embeddings.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels; image-derived numeric features', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (84, '25.1', 'Subcellular', 'Subcellular UMAP image features', 'Image metadata, UMAP coordinates and 1,024 numeric features. The file does not contain the source image pixels.', 'Image-derived feature data', 'subcell_image_umap_features.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/subcell_image_umap_features.tsv.zip', 'https://www.proteinatlas.org/humanproteome/subcellular/data', 'Subcellular UMAP', 'subcell_image_umap_features.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels; image-derived numeric features', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (85, '25.1', 'Cancer', 'Cancer IHC protein expression', 'IHC staining profiles across 20 tumor types.', 'Primary annotation data', 'cancer_data.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cancer_data.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'Cancer IHC', 'cancer_data.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels; annotation table', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (86, '25.1', 'Cancer', 'Cancer type lookup', 'Cancer type and organ metadata for 20 tumor types.', 'Metadata', 'cancer_cancers.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cancer_cancers.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'Cancer IHC', 'cancer_cancers.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (87, '25.1', 'Cancer', 'Cancer prognostic data', 'Log-rank survival analyses for TCGA and validation cohorts.', 'Derived analysis data', 'cancer_prognostic_data.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cancer_prognostic_data.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'Cancer survival', 'cancer_prognostic_data.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (88, '25.1', 'Cancer', 'TCGA cancer cohort lookup', 'Metadata for 21 TCGA cancer cohorts.', 'Metadata', 'cancer_rna_tcga_cancers.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cancer_rna_tcga_cancers.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'Cancer RNA', 'cancer_rna_tcga_cancers.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (89, '25.1', 'Cancer', 'Validation cancer cohort lookup', 'Metadata for 10 validation cancer cohorts.', 'Metadata', 'cancer_rna_validation_cancers.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cancer_rna_validation_cancers.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'Cancer RNA', 'cancer_rna_validation_cancers.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (90, '25.1', 'Cancer', 'TCGA cancer sample RNA', 'Gene-level RNA expression across 8,384 cancer samples.', 'Primary sample-level data', 'rna_cancer_sample.tsv.gz', 'TSV', 'GZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_cancer_sample.tsv.gz', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'Cancer RNA', 'rna_cancer_sample.tsv.gz', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (91, '25.1', 'Cancer', 'CPTAC cancer proteomics', 'Differential mass-spectrometry protein expression across 11 cancer types.', 'Primary differential data', 'cancer_cptac.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cancer_cptac.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'CPTAC proteomics', 'cancer_cptac.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (92, '25.1', 'Cancer', 'CPTAC cancer lookup', 'Metadata for the 11 CPTAC cancer types.', 'Metadata', 'cancer_cptac_cancers.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cancer_cptac_cancers.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cancer/data', 'CPTAC proteomics', 'cancer_cptac_cancers.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (93, '25.1', 'Blood', 'Blood disease differential protein expression', 'Differential protein expression across 59 diseases.', 'Derived analysis data', 'blood_pea_disease_de.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/blood_pea_disease_de.tsv.zip', 'https://www.proteinatlas.org/humanproteome/blood/data', 'Blood disease', 'blood_pea_disease_de.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (94, '25.1', 'Blood', 'Blood disease lookup', 'Disease metadata covering 60 entries.', 'Metadata', 'blood_pea_diseases.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/blood_pea_diseases.tsv.zip', 'https://www.proteinatlas.org/humanproteome/blood/data', 'Blood disease', 'blood_pea_diseases.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (95, '25.1', 'Blood', 'Blood protein concentration, immunoassay', 'Blood protein concentrations measured using immunoassays.', 'Primary aggregate data', 'blood_immunoassay_concentration.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/blood_immunoassay_concentration.tsv.zip', 'https://www.proteinatlas.org/humanproteome/blood/data', 'Blood protein concentration', 'blood_concentration_immunoassay.tsv.zip', 'Actual href audited; the visible label differs from the download target.', 'No image pixels', NULL, 1788220800000, 'The visible label and actual download filename use different word order.', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (96, '25.1', 'Blood', 'Blood protein concentration, mass spectrometry', 'Blood protein concentrations measured using mass spectrometry.', 'Primary aggregate data', 'blood_ms_concentration.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/blood_ms_concentration.tsv.zip', 'https://www.proteinatlas.org/humanproteome/blood/data', 'Blood protein concentration', 'blood_ms_concentration.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, 'The Blood web resource contains additional interactive datasets that are not exposed as extra current bulk-download links on this page.', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (97, '25.1', 'Cell Line', 'Cell-line cancer-group RNA', 'RNA expression across 28 cancer cell-line groups.', 'Primary aggregate data', 'rna_cell_line_cancer.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_cell_line_cancer.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cell%2Bline/data', 'Cancer groups', 'rna_cell_line_cancer.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (98, '25.1', 'Cell Line', 'Cell-line cancer-group lookup', 'Metadata for 30 cell-line cancer groups.', 'Metadata', 'rna_cell_line_cancer_cancers.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_cell_line_cancer_cancers.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cell%2Bline/data', 'Cancer groups', 'rna_cell_line_cancer_cancers.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (99, '25.1', 'Cell Line', 'Cell-line RNA', 'Gene-level RNA expression across 1,206 cell lines.', 'Primary detailed data', 'rna_celline.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_celline.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cell%2Bline/data', 'Cell lines', 'rna_celline.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (100, '25.1', 'Cell Line', 'Cell-line versus TCGA comparison', 'Rankings and correlations comparing 1,132 cancer cell lines with corresponding TCGA cancers.', 'Derived analysis data', 'rna_cell_line_tcga_comparison.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_cell_line_tcga_comparison.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cell%2Bline/data', 'Cancer comparison', 'rna_cell_line_tcga_comparison.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (101, '25.1', 'Cell Line', 'Cell-line pathway and cytokine analysis', 'PROGENy and CytoSig analysis for 1,206 cell lines.', 'Derived analysis data', 'cell_line_analysis_data.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/cell_line_analysis_data.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cell%2Bline/data', 'Functional analysis', 'cell_line_analysis_data.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (102, '25.1', 'Cell Line', 'Cell-line lookup', 'Metadata for the HPA cell-line collection.', 'Metadata', 'rna_cell_lines.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/rna_cell_lines.tsv.zip', 'https://www.proteinatlas.org/humanproteome/cell%2Bline/data', 'Cell lines', 'rna_cell_lines.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, 'The interactive resource also presents protein information, but the current bulk page exposes these RNA and analysis tables.', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (103, '25.1', 'Interaction', 'Consensus protein interactions', 'Interacting protein pairs for genes with consensus interaction data.', 'Primary interaction data', 'interaction_consensus.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/tsv/interaction_consensus.tsv.zip', 'https://www.proteinatlas.org/humanproteome/interaction/interaction/data', 'Protein interaction data', 'interaction_consensus.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (104, '25.1', 'Master', 'Protein Atlas search-result subset, TSV', 'Tab-separated subset corresponding to the fields displayed in HPA search results.', 'Master subset', 'proteinatlas.tsv.zip', 'TSV', 'ZIP', 1779667200000, 'https://www.proteinatlas.org/download/proteinatlas.tsv.zip', 'https://www.proteinatlas.org/about/download', 'Protein Atlas data', 'proteinatlas.tsv.zip', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (105, '25.1', 'Master', 'Protein Atlas search-result subset, JSON', 'The same search-result subset as the master TSV, serialized as JSON.', 'Master subset', 'proteinatlas.json.gz', 'JSON', 'GZIP', 1779667200000, 'https://www.proteinatlas.org/download/proteinatlas.json.gz', 'https://www.proteinatlas.org/about/download', 'Protein Atlas data', 'proteinatlas.json.gz', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (106, '25.1', 'Master', 'Protein Atlas XML schema', 'XSD schema describing the structure of the master HPA XML export.', 'Schema', 'proteinatlas.xsd', 'XSD', 'None', 1779667200000, 'https://www.proteinatlas.org/download/proteinatlas.xsd', 'https://www.proteinatlas.org/about/download', 'Protein Atlas data', 'proteinatlas.xsd', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, NULL, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  (107, '25.1', 'Master', 'Protein Atlas master XML', 'Compressed XML containing most, but not all, HPA data, including normal and tumor protein expression, cell lines, antibody information, RNA-seq and external identifiers.', 'Broad master export', 'proteinatlas.xml.gz', 'XML', 'GZIP', 1779667200000, 'https://www.proteinatlas.org/download/proteinatlas.xml.gz', 'https://www.proteinatlas.org/about/download', 'Protein Atlas data', 'proteinatlas.xml.gz', 'Actual href extracted from the official HPA source page.', 'No image pixels', NULL, 1788220800000, 'HPA describes this as containing most of the atlas, not every separately downloadable dataset.', @atlasai_seed_unix_ms, @atlasai_seed_unix_ms);
