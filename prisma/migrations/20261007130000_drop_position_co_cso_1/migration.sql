-- Position CO-CSO-1 merged into CO-CSO: repoint every reference, then delete it.
-- No-op unless both positions exist.
DO $$
DECLARE
  old_id TEXT := (SELECT "id" FROM "positions" WHERE "code" = 'CO-CSO-1');
  new_id TEXT := (SELECT "id" FROM "positions" WHERE "code" = 'CO-CSO');
BEGIN
  IF old_id IS NULL OR new_id IS NULL THEN RETURN; END IF;
  UPDATE "users" SET "positionId" = new_id WHERE "positionId" = old_id;
  UPDATE "approval_level_steps" SET "positionId" = new_id WHERE "positionId" = old_id;
  UPDATE "approval_level_requestor_positions" SET "positionId" = new_id
    WHERE "positionId" = old_id
      AND NOT EXISTS (SELECT 1 FROM "approval_level_requestor_positions" r WHERE r."approvalLevelId" = "approval_level_requestor_positions"."approvalLevelId" AND r."positionId" = new_id);
  DELETE FROM "approval_level_requestor_positions" WHERE "positionId" = old_id;
  UPDATE "department_position_assignments" SET "positionId" = new_id
    WHERE "positionId" = old_id
      AND NOT EXISTS (SELECT 1 FROM "department_position_assignments" d WHERE d."departmentId" = "department_position_assignments"."departmentId" AND d."positionId" = new_id);
  DELETE FROM "department_position_assignments" WHERE "positionId" = old_id;
  UPDATE "approval_request_steps" SET "positionId" = new_id WHERE "positionId" = old_id;
  UPDATE "approval_actions" SET "positionId" = new_id WHERE "positionId" = old_id;
  UPDATE "expenses" SET "status" = 'APPROVAL_CO_CSO' WHERE "status" = 'APPROVAL_CO_CSO_1';
  DELETE FROM "positions" WHERE "id" = old_id;
END $$;
