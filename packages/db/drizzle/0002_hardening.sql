CREATE TABLE "company_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"token" varchar(64) NOT NULL,
	"role" varchar(16) DEFAULT 'manager' NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_by_user_id" integer,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
DROP INDEX "deals_request_uq";--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "closed_by" varchar(16);--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "counted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "flag" varchar(32);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_invites" ADD CONSTRAINT "company_invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_invites" ADD CONSTRAINT "company_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_invites" ADD CONSTRAINT "company_invites_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_invites_company_idx" ON "company_invites" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_request_active_uq" ON "deals" USING btree ("request_id") WHERE "deals"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "deals_request_idx" ON "deals" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "deals_status_idx" ON "deals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "memberships_company_idx" ON "memberships" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id","state");--> statement-breakpoint
CREATE INDEX "users_phone_hash_idx" ON "users" USING btree ("phone_hash");