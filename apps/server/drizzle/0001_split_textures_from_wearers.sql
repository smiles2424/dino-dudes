CREATE TABLE "textures" (
	"hash" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-added to the generated migration (Wave 5, Chunk 5.2): move the blobs
-- across before the column that holds them is dropped. Content-addressed, so
-- "the same hash twice" is the same drawing and the oldest row wins the
-- created_at. (When this ran against the real Neon database `avatars` was
-- empty, so it moved nothing — it is here so the migration is honest for any
-- database that does have rows.)
INSERT INTO "textures" ("hash", "bytes", "created_at")
SELECT DISTINCT ON ("texture_hash") "texture_hash", "texture", "created_at"
FROM "avatars"
ORDER BY "texture_hash", "created_at"
ON CONFLICT ("hash") DO NOTHING;--> statement-breakpoint
-- `avatars` becomes one row per player, so any history is collapsed onto the
-- most recent drawing that player uploaded.
DELETE FROM "avatars" a
USING "avatars" b
WHERE a."player_id" = b."player_id"
  AND (b."created_at", b."id") > (a."created_at", a."id");--> statement-breakpoint
DROP INDEX "avatars_texture_hash_key";--> statement-breakpoint
DROP INDEX "avatars_player_id_idx";--> statement-breakpoint
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_texture_hash_textures_hash_fk" FOREIGN KEY ("texture_hash") REFERENCES "public"."textures"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "avatars_player_id_key" ON "avatars" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "avatars_texture_hash_idx" ON "avatars" USING btree ("texture_hash");--> statement-breakpoint
ALTER TABLE "avatars" DROP COLUMN "texture";
