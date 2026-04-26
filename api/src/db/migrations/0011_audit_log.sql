CREATE TABLE audit_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id   BINARY(16)      NULL,
  household_id    BINARY(16)      NULL,
  action          VARCHAR(80)     NOT NULL,
  target_type     VARCHAR(40)     NULL,
  target_id       BINARY(16)      NULL,
  ip_address      VARBINARY(16)   NULL,
  user_agent      VARCHAR(255)    NULL,
  metadata        JSON            NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_actor_time (actor_user_id, created_at),
  KEY idx_audit_household_time (household_id, created_at),
  KEY idx_audit_action_time (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
