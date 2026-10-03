CREATE TABLE "gigs" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"category_id" integer,
	"title" varchar(160) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cover" varchar(300),
	"gallery" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"packages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "gig_id" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "gig_package" varchar(16);--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "preferred_company_id" integer;--> statement-breakpoint
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gigs_company_idx" ON "gigs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "gigs_category_idx" ON "gigs" USING btree ("category_id","active");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_gig_id_gigs_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gigs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_preferred_company_id_companies_id_fk" FOREIGN KEY ("preferred_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;