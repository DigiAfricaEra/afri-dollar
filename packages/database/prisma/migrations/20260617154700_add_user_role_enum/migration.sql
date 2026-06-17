-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserRole') THEN
    CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
  END IF;
END$$;

-- Perform safe migration of the role column
DO $$
BEGIN
  -- Check if the role column already exists
  IF EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_name = 'User' 
      AND table_schema = current_schema()
      AND column_name = 'role'
  ) THEN
    -- If it's a character type, migrate the data and alter the type
    IF EXISTS (
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_name = 'User' 
        AND table_schema = current_schema()
        AND column_name = 'role' 
        AND data_type IN ('character varying', 'text', 'character')
    ) THEN
      -- Update existing string values to match enum
      UPDATE "User"
      SET "role" = CASE
        WHEN UPPER("role") = 'ADMIN' THEN 'ADMIN'
        ELSE 'USER'
      END;

      -- Alter column type to UserRole
      ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole" USING "role"::"UserRole";
      ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';
    END IF;
    -- If column exists but is not character type, assume it's already correct (UserRole enum)
  ELSE
    -- Column doesn't exist, add it
    ALTER TABLE "User" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';
  END IF;
END$$;
