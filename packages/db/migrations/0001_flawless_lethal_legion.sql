CREATE TABLE "operator_mandates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"thresholds" jsonb NOT NULL,
	"signed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_mandates_org_version_uq" UNIQUE("organisation_id","version")
);
--> statement-breakpoint
ALTER TABLE "operator_mandates" ADD CONSTRAINT "operator_mandates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_mandates" ADD CONSTRAINT "operator_mandates_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;