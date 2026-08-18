CREATE TABLE "avatars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"model_slug" text NOT NULL,
	"texture" "bytea" NOT NULL,
	"texture_hash" text NOT NULL,
	"source_photo" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lobbies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lobby_members" (
	"lobby_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lobby_members_lobby_id_player_id_pk" PRIMARY KEY("lobby_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lobby_members" ADD CONSTRAINT "lobby_members_lobby_id_lobbies_id_fk" FOREIGN KEY ("lobby_id") REFERENCES "public"."lobbies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lobby_members" ADD CONSTRAINT "lobby_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "avatars_texture_hash_key" ON "avatars" USING btree ("texture_hash");--> statement-breakpoint
CREATE INDEX "avatars_player_id_idx" ON "avatars" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lobbies_code_key" ON "lobbies" USING btree ("code");