CREATE TABLE Contact (
    id SERIAL PRIMARY KEY,
    phoneNumber VARCHAR(255),
    email VARCHAR(255),
    linkedId INTEGER,
    linkPrecedence VARCHAR(10) CHECK (linkPrecedence IN ('primary', 'secondary')),
    createdAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deletedAt TIMESTAMP WITH TIME ZONE,
    FOREIGN KEY (linkedId) REFERENCES Contact(id)
);

-- Add indexes for faster lookups (good practice!)
CREATE INDEX idx_contact_email ON Contact(email);
CREATE INDEX idx_contact_phonenumber ON Contact(phoneNumber);
CREATE INDEX idx_contact_linkedid ON Contact(linkedId);

-- Optional: Trigger to update `updatedAt` automatically (for PostgreSQL)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updatedAt = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_contact_updated_at
BEFORE UPDATE ON Contact
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();