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
  `output_price_microusd_per_million_tokens` BIGINT UNSIGNED NULL,
  `catalog_verified_unix_ms` BIGINT UNSIGNED NOT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inference_models_config_key` (`config_key`),
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
  `client_fingerprint_sha256` BINARY(32) NULL,
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

CREATE TABLE `atlasai`.`access_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `match_type` ENUM('visitor','ip','ip_cidr','asn','country','ja3','ja4') NOT NULL,
  `match_value` VARBINARY(255) NOT NULL COMMENT 'Canonical binary representation selected by match_type',
  `match_sha256` BINARY(32) NOT NULL COMMENT 'SHA-256 of match_type plus canonical value',
  `visitor_id` BIGINT UNSIGNED NULL,
  `action` ENUM('block','allow','challenge','log') NOT NULL,
  `priority` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `status` ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  `active_match_sha256` BINARY(32) GENERATED ALWAYS AS (
    CASE WHEN `status` = 'active' THEN `match_sha256` ELSE NULL END
  ) STORED,
  `reason` VARCHAR(1024) NOT NULL,
  `created_by` VARCHAR(128) NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `expires_unix_ms` BIGINT UNSIGNED NULL,
  `revoked_unix_ms` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_access_rules_public_id` (`public_id`),
  UNIQUE KEY `uq_access_rules_one_active_match` (`active_match_sha256`),
  KEY `idx_access_rules_visitor` (`visitor_id`, `status`),
  KEY `idx_access_rules_status_type` (`status`, `match_type`, `priority`, `created_unix_ms`, `id`),
  KEY `idx_access_rules_expiry` (`status`, `expires_unix_ms`, `id`),
  CONSTRAINT `fk_access_rules_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_access_rules_visitor_shape` CHECK (
    (`match_type` = 'visitor' AND `visitor_id` IS NOT NULL)
    OR (`match_type` <> 'visitor' AND `visitor_id` IS NULL)
  ),
  CONSTRAINT `chk_access_rules_expiry` CHECK (`expires_unix_ms` IS NULL OR `expires_unix_ms` >= `created_unix_ms`),
  CONSTRAINT `chk_access_rules_revocation` CHECK (
    (`status` = 'revoked' AND `revoked_unix_ms` IS NOT NULL)
    OR (`status` <> 'revoked' AND `revoked_unix_ms` IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;

CREATE TABLE `atlasai`.`conversations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` BINARY(16) NOT NULL COMMENT 'UUIDv7 bytes',
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('active','archived','deleted') NOT NULL DEFAULT 'active',
  `title` VARCHAR(512) NOT NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `updated_unix_ms` BIGINT UNSIGNED NOT NULL,
  `archived_unix_ms` BIGINT UNSIGNED NULL,
  `deleted_unix_ms` BIGINT UNSIGNED NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_conversations_public_id` (`public_id`),
  KEY `idx_conversations_visitor_updated` (`visitor_id`, `status`, `updated_unix_ms`, `id`),
  CONSTRAINT `fk_conversations_visitor`
    FOREIGN KEY (`visitor_id`) REFERENCES `atlasai`.`visitors` (`id`)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_conversations_time_order` CHECK (`updated_unix_ms` >= `created_unix_ms`),
  CONSTRAINT `chk_conversations_archived` CHECK (
    (`status` = 'archived' AND `archived_unix_ms` IS NOT NULL AND `deleted_unix_ms` IS NULL)
    OR (`status` = 'deleted' AND `deleted_unix_ms` IS NOT NULL)
    OR (`status` = 'active' AND `archived_unix_ms` IS NULL AND `deleted_unix_ms` IS NULL)
  )
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
  `status` ENUM('pending','ready','failed','deleted') NOT NULL DEFAULT 'ready',
  `name` VARCHAR(512) NOT NULL,
  `producer_key` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purpose` VARCHAR(1024) NULL,
  `storage_uri` VARCHAR(2048) NOT NULL,
  `content_type` VARCHAR(255) NULL,
  `size_bytes` BIGINT UNSIGNED NULL,
  `sha256` BINARY(32) NULL,
  `schema_json` JSON NULL,
  `created_unix_ms` BIGINT UNSIGNED NOT NULL,
  `deleted_unix_ms` BIGINT UNSIGNED NULL,
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
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT `chk_aso_artifacts_deleted` CHECK (
    (`status` = 'deleted' AND `deleted_unix_ms` IS NOT NULL)
    OR (`status` <> 'deleted' AND `deleted_unix_ms` IS NULL)
  )
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
  `original_filename` VARCHAR(1024) NULL,
  `input_sha256` BINARY(32) NULL,
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
  `provider_request_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  `input_tokens` BIGINT UNSIGNED NULL,
  `cached_input_tokens` BIGINT UNSIGNED NULL,
  `output_tokens` BIGINT UNSIGNED NULL,
  `reasoning_tokens` BIGINT UNSIGNED NULL,
  `total_tokens` BIGINT UNSIGNED NULL,
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
  `tool_key` ENUM('deep_research_hpa','investigator_hpa','check_inclusion_hpa','dictionary_expert_hpa','aso_hpa') NOT NULL,
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
  `request_event_id` BIGINT UNSIGNED NULL,
  `conversation_id` BIGINT UNSIGNED NULL,
  `run_id` BIGINT UNSIGNED NULL,
  `batch_query_id` BIGINT UNSIGNED NULL,
  `workspace_id` BIGINT UNSIGNED NULL,
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
  `catalog_verified_unix_ms`,
  `created_unix_ms`,
  `updated_unix_ms`
) VALUES
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-gpt-oss-120b',       'openai/gpt-oss-120b',              'Groq GPT-OSS 120B',    'inactive', 1, 1, 1, 1, 0, 1, 131072,  65536, 8192,  150000,   600000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-gpt-oss-20b',        'openai/gpt-oss-20b',               'Groq GPT-OSS 20B',     'inactive', 1, 1, 1, 1, 0, 1, 131072,  65536, 8192,   75000,   300000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-qwen-3.6-27b',       'qwen/qwen3.6-27b',                 'Qwen 3.6 27B (Preview)','inactive', 1, 1, 1, 1, 1, 1, 131072,  16384, 8192,  600000,  3000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'groq'),      'groq-qwen-3.8-27b',       'qwen/qwen3.8-27b',                 'Qwen 3.8 27B (Preview)','inactive', 1, 1, 1, 1, 1, 1, 131042,  16384, 8192,  800000,  4000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic'), 'anthropic-claude-opus-5',  'claude-opus-5',                      'Claude Opus 5',         'inactive', 1, 1, 1, 1, 1, 1, 1000000, 128000, 8192, 5000000, 25000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic'), 'anthropic-claude-sonnet-5','claude-sonnet-5',                    'Claude Sonnet 5',       'inactive', 1, 1, 1, 1, 1, 1, 1000000, 128000, 8192, 2000000, 10000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms),
  ((SELECT `id` FROM `atlasai`.`inference_providers` WHERE `provider_key` = 'anthropic'), 'anthropic-claude-haiku-4-5','claude-haiku-4-5-20251001',          'Claude Haiku 4.5',      'inactive', 1, 1, 1, 1, 1, 1,  200000,  64000, 8192, 1000000,  5000000, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms, @atlasai_seed_unix_ms);

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
