CREATE TABLE "favorites" (
	"user_id" integer NOT NULL,
	"gig_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_gig_id_pk" PRIMARY KEY("user_id","gig_id")
);
--> statement-breakpoint
CREATE TABLE "gig_views" (
	"user_id" integer NOT NULL,
	"gig_id" integer NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminded_at" timestamp with time zone,
	CONSTRAINT "gig_views_user_id_gig_id_pk" PRIMARY KEY("user_id","gig_id")
);
--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "plan_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "gig_id" integer;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "payment_status" varchar(16) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "fee_uzs" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "reorder_nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "kind" varchar(8) DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deal_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount_uzs" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bonus_uzs" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referred_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_rewarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bonus_uzs" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_gig_id_gigs_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gigs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gig_views" ADD CONSTRAINT "gig_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gig_views" ADD CONSTRAINT "gig_views_gig_id_gigs_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gigs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gig_views_viewed_idx" ON "gig_views" USING btree ("viewed_at");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_gig_id_gigs_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gigs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chats_gig_buyer_uq" ON "chats" USING btree ("gig_id","buyer_user_id") WHERE "chats"."request_id" is null;--> statement-breakpoint
CREATE INDEX "deals_payment_idx" ON "deals" USING btree ("payment_status");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_deal_open_uq" ON "invoices" USING btree ("deal_id") WHERE "invoices"."kind" = 'deal' and "invoices"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "users_referred_by_idx" ON "users" USING btree ("referred_by_user_id");