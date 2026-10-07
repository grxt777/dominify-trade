ALTER TABLE "requests" ADD COLUMN "delivery_needed" boolean;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "delivery_lat" double precision;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "delivery_lng" double precision;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "delivery_address" varchar(300);