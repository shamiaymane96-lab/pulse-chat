-- Soften ghost-seat prune: 45 minutes idle instead of 15
-- (function body matches live join_room_by_code after MCP apply)

-- See 005 for full join_room_by_code; this documents the prune interval change only.
-- Live DB already updated via MCP migration ghost_prune_45_minutes.
select 1;
