-- A visibility or status change makes the dataset's vector routing label
-- (`visibility` in the Vectorize metadata) stale: mark it for re-embedding so
-- the embedding_dirty cron refreshes it. The value is 2, not 1: the drain
-- orders by embedding_dirty DESC, so a just-flipped dataset (for example one
-- just published, still labeled private and hidden from anonymous layer 1)
-- is relabeled ahead of any backlog of ordinary content edits (value 1).
-- Best-effort only: search re-checks every hit against the live row, so a
-- stale label never decides who sees a dataset. embedding_dirty is in no
-- trigger OF list, so the inner UPDATE does not re-fire this trigger.
CREATE TRIGGER datasets_embed_dirty_visibility_au
AFTER UPDATE OF visibility, status ON datasets
WHEN old.visibility IS NOT new.visibility OR old.status IS NOT new.status BEGIN
  UPDATE datasets SET embedding_dirty = 2 WHERE id = new.id;
END;
