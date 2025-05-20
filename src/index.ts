// src/index.ts
import express, { Request, Response, NextFunction } from 'express';
import pool from './db'; 

const app = express();
const port = process.env.PORT || 3000; // heroku/render port or local 3000

app.use(express.json()); // needs to be able to parse json

interface ContactRow {
  id: number;
  phonenumber: string | null;
  email: string | null;
  linkedid: number | null;
  linkprecedence: 'primary' | 'secondary';
  createdat: Date;
  updatedat: Date;
  deletedat: Date | null;
}

app.post('/identify', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  console.log('Received /identify request with body:', req.body);

  const { email, phoneNumber: requestPhoneNumber } = req.body as { email?: string | null; phoneNumber?: string | null };

  // gotta have email or phone, or both
  if (requestPhoneNumber === undefined && email === undefined) {
    res.status(400).json({
    error: "Either email or phoneNumber (or both) must be present in the request body.",
    });
    return;
}
  
const trimmedEmail = typeof email === 'string' ? email.trim() : null; 
const isEmailProvided = trimmedEmail !== null && trimmedEmail !== '';
const isPhoneNumberProvided = typeof requestPhoneNumber === 'string' ? requestPhoneNumber.trim() !== '';

// check for empty strings too
if (!isEmailProvided && !isPhoneNumberProvided) {
    res.status(400).json({
    error: "At least one of email or phoneNumber must have a non-empty value.",
    });
    return;
}

const queryEmail = isEmailProvided ? trimmedEmail.toLowerCase() : null; // always lowercase email
const queryPhoneNumber = isPhoneNumberProvided ? requestPhoneNumber.trim() : null; // phone num already trimmed

  const client = await pool.connect(); // db client

  try {
    // look for contacts with this email or phone
    const findContactsQuery = `
      SELECT id, phonenumber, email, linkedid, linkprecedence, createdat, updatedat, deletedat
      FROM Contact
      WHERE deletedat IS NULL AND
            ((email = $1 AND $1 IS NOT NULL) OR (phonenumber = $2 AND $2 IS NOT NULL))
      ORDER BY createdat ASC;
    `;
    const { rows: matchingContacts } = await client.query<ContactRow>(findContactsQuery, [queryEmail, queryPhoneNumber]);

    if (matchingContacts.length === 0) {
      // no matches? new guy. make 'em primary
      const insertContactQuery = `
        INSERT INTO Contact (email, phonenumber, linkprecedence)
        VALUES ($1, $2, 'primary')
        RETURNING id, email, phonenumber;
      `;
      const { rows: newContactRows } = await client.query(insertContactQuery, [queryEmail, queryPhoneNumber]);
      const newContact = newContactRows[0];

      res.status(200).json({
        contact: {
          primaryContatctId: newContact.id,
          emails: newContact.email ? [newContact.email] : [], // could be null
          phoneNumbers: newContact.phonenumber ? [newContact.phonenumber] : [], // also could be null
          secondaryContactIds: [],
        },
      });

    } else {
      // got some matches, figure it out
      console.log("Original matching contacts based on input:", matchingContacts.map(c => ({id: c.id, email: c.email, phone: c.phonenumber, precedence: c.linkprecedence, linkedId: c.linkedid })));

      const implicatedPrimaryIds = new Set<number>(); // what primaries are we dealing with
      for (const contact of matchingContacts) {
        if (contact.linkprecedence === 'primary') {
          implicatedPrimaryIds.add(contact.id);
        } else if (contact.linkedid !== null) { // if secondary, use its primary's id
          implicatedPrimaryIds.add(contact.linkedid);
        }
      }

      // if matches found but no primary ids... weird. data issue?
      if (implicatedPrimaryIds.size === 0 && matchingContacts.length > 0) {
        console.error("Could not determine any implicated primary IDs from matches:", matchingContacts);
        throw new Error("Data inconsistency: Could not trace matches to a primary contact.");
      }
      
      let ultimatePrimaryContact: ContactRow | undefined;

      if (implicatedPrimaryIds.size <= 1) {
        // simple case, one group involved
  
        const primaryDirectMatches = matchingContacts.filter(c => c.linkprecedence === 'primary');
        if (primaryDirectMatches.length > 0) {
            // got a primary directly, use oldest
            ultimatePrimaryContact = primaryDirectMatches[0];
        } else if (matchingContacts.length > 0 && matchingContacts[0].linkedid !== null) {
            // all matches were secondary, grab their primary
            const primaryId = matchingContacts[0].linkedid;
            const primaryResult = await client.query<ContactRow>("SELECT * FROM Contact WHERE id = $1 AND deletedat IS NULL", [primaryId]);
            if (primaryResult.rows.length > 0) {
                ultimatePrimaryContact = primaryResult.rows[0];
            } else {
                // this would be bad, primary linkedid points to nothing
                throw new Error(`Data inconsistency: Primary contact for ID ${primaryId} not found or deleted.`);
            }
        } else if (matchingContacts.length > 0) {
             // still couldn't find a primary from the matches.
             throw new Error("Could not determine primary contact from the initial matches due to data inconsistency.");
        }
      } else {
        // ok, multiple primary groups. MERGE TIME.
        console.log("Multiple primary identities implicated. IDs:", Array.from(implicatedPrimaryIds), ". Merge required.");
        
        await client.query('BEGIN'); // transaction!

        try {
            // get all these primary candidates, oldest first
            const primaryCandidatesQuery = `SELECT * FROM Contact WHERE id = ANY($1::int[]) AND deletedat IS NULL ORDER BY createdat ASC;`;
            const { rows: potentialPrimariesAllTypes } = await client.query<ContactRow>(primaryCandidatesQuery, [Array.from(implicatedPrimaryIds)]);

            // only consider current primaries for demotion
            const potentialCurrentPrimaries = potentialPrimariesAllTypes.filter(c => c.linkprecedence ==='primary');

            if (potentialCurrentPrimaries.length === 0) {
                // no current primaries among them? maybe all were secondaries linked to diff primaries
                // or they got demoted before. Pick oldest overall from the implicated set.
                if(potentialPrimariesAllTypes.length === 0){
                    throw new Error("Could not find any primary candidates for merging."); // safety check
                }
                ultimatePrimaryContact = potentialPrimariesAllTypes[0]; // oldest overall
                console.log("Ultimate Primary selected (oldest overall contact):", {id: ultimatePrimaryContact.id, email: ultimatePrimaryContact.email, createdat: ultimatePrimaryContact.createdat});

                // make sure this one is really primary now
                if(ultimatePrimaryContact.linkprecedence !== 'primary' || ultimatePrimaryContact.linkedid !== null) {
                    await client.query(
                        "UPDATE Contact SET linkprecedence = 'primary', linkedid = NULL, updatedat = NOW() WHERE id = $1",
                        [ultimatePrimaryContact.id]
                    );
                    ultimatePrimaryContact.linkprecedence = 'primary'; // update our obj too
                    ultimatePrimaryContact.linkedid = null;
                }

                // demote the rest from this 'all types' list
                for (const contact of potentialPrimariesAllTypes) {
                    if (contact.id !== ultimatePrimaryContact.id) {
                        console.log(`Updating contact ID ${contact.id} to be secondary of ${ultimatePrimaryContact.id}`);
                        await client.query( 
                            "UPDATE Contact SET linkprecedence = 'secondary', linkedid = $1, updatedat = NOW() WHERE id = $2",
                            [ultimatePrimaryContact.id, contact.id]
                        );
                        // move their kids too
                        await client.query(
                            "UPDATE Contact SET linkedid = $1, updatedat = NOW() WHERE linkedid = $2 AND id != $1", 
                            [ultimatePrimaryContact.id, contact.id]
                        );
                    }
                }

            } else {
                // we have current primaries in the mix. oldest of *these* wins.
                ultimatePrimaryContact = potentialCurrentPrimaries[0]; 
                console.log("Ultimate Primary selected for merge (oldest current primary):", {id: ultimatePrimaryContact.id, email: ultimatePrimaryContact.email, createdat: ultimatePrimaryContact.createdat});

                // demote the other current primaries
                for (const oldPrimary of potentialCurrentPrimaries) {
                    if (oldPrimary.id !== ultimatePrimaryContact.id) {
                        console.log(`Demoting primary ID ${oldPrimary.id} to secondary of ${ultimatePrimaryContact.id}`);
                        await client.query(
                        "UPDATE Contact SET linkprecedence = 'secondary', linkedid = $1, updatedat = NOW() WHERE id = $2",
                        [ultimatePrimaryContact.id, oldPrimary.id]
                        );
                        // and re-link their secondaries
                        await client.query(
                        "UPDATE Contact SET linkedid = $1, updatedat = NOW() WHERE linkedid = $2 AND id != $1",
                        [ultimatePrimaryContact.id, oldPrimary.id]
                        );
                    }
                }
            }
            await client.query('COMMIT'); // good to go
        } catch (e) {
            await client.query('ROLLBACK'); // oops, undo merge
            throw e; 
        }
      }
      
      // by now, we MUST have a primary
      if (!ultimatePrimaryContact) {
        throw new Error("Ultimate primary contact could not be determined after all logic."); // should not happen
      }

      // get all contacts for this primary's group
      const groupContactsQuery = `
        SELECT id, phonenumber, email, linkedid, linkprecedence, createdat
        FROM Contact
        WHERE deletedat IS NULL AND (id = $1 OR linkedid = $1)
        ORDER BY linkprecedence ASC, createdat ASC; 
      `;
      const { rows: groupContacts } = await client.query<ContactRow>(groupContactsQuery, [ultimatePrimaryContact.id]);
      let allContactsInGroup = groupContacts; 
      
      console.log("All contacts in the final group (post-merge if any):", allContactsInGroup.map(c =>({id: c.id, email: c.email, phone: c.phonenumber, precedence: c.linkprecedence, linkedId: c.linkedid })));

      // is this request adding new info?
      const currentRequestEmail = queryEmail;
      const currentRequestPhoneNumber = queryPhoneNumber;

      // does this exact email/phone pair already exist in the final group?
      const exactMatchExists = allContactsInGroup.some(contact =>
        contact.email === currentRequestEmail && contact.phonenumber === currentRequestPhoneNumber
      );

      if (!exactMatchExists && (currentRequestEmail || currentRequestPhoneNumber)) { // not a dup & has info
          // did the input link to this group via *any* of the original matches?
          const sharesIdentifierWithGroup = matchingContacts.some(mc => 
            (currentRequestEmail && mc.email === currentRequestEmail) ||
            (currentRequestPhoneNumber && mc.phonenumber === currentRequestPhoneNumber)
          );

          if(sharesIdentifierWithGroup) { 
                // yup, new info for this group. create secondary.
                console.log("New information identified for this group or new combination. Creating secondary contact linked to ultimate primary.");
                const insertSecondaryQuery = `
                    INSERT INTO Contact (email, phonenumber, linkprecedence, linkedid)
                    VALUES ($1, $2, 'secondary', $3)
                    RETURNING id, phonenumber, email, linkedid, linkprecedence, createdat;
                `;
                const { rows: newSecondaryRows } = await client.query<ContactRow>(insertSecondaryQuery, [
                    currentRequestEmail,
                    currentRequestPhoneNumber,
                    ultimatePrimaryContact.id
                ]);
                if (newSecondaryRows.length > 0) {
                    allContactsInGroup.push(newSecondaryRows[0]); // add to our list for the response
                    console.log("New secondary contact created:", newSecondaryRows[0]);
                }
            }
      }

      // Prep for response
      const primaryEmailForResponse = ultimatePrimaryContact.email;
      const primaryPhoneNumberForResponse = ultimatePrimaryContact.phonenumber;

      const emailsSet = new Set<string>(); // use Set for uniqueness
      if (primaryEmailForResponse) emailsSet.add(primaryEmailForResponse);
      allContactsInGroup.forEach(c => { if (c.email) emailsSet.add(c.email); });
      // primary's email first in list
      const emailsArray = primaryEmailForResponse 
        ? [primaryEmailForResponse, ...Array.from(emailsSet).filter(e => e !== primaryEmailForResponse)] 
        : Array.from(emailsSet);

      const phoneNumbersSet = new Set<string>();
      if (primaryPhoneNumberForResponse) phoneNumbersSet.add(primaryPhoneNumberForResponse);
      allContactsInGroup.forEach(c => { if (c.phonenumber) phoneNumbersSet.add(c.phonenumber); });
      // primary's phone first
      const phoneNumbersArray = primaryPhoneNumberForResponse 
        ? [primaryPhoneNumberForResponse, ...Array.from(phoneNumbersSet).filter(p => p !== primaryPhoneNumberForResponse)] 
        : Array.from(phoneNumbersSet);
      
      const secondaryContactIds = allContactsInGroup
        .filter(c => c.id !== ultimatePrimaryContact.id) // others in group are secondary
        .map(c => c.id)
        .filter((id, index, self) => self.indexOf(id) === index) // unique ids (just in case)
        .sort((a,b) => a-b); // sort for consistency

      res.status(200).json({
        contact: {
          primaryContatctId: ultimatePrimaryContact.id,
          emails: emailsArray,
          phoneNumbers: phoneNumbersArray,
          secondaryContactIds: secondaryContactIds,
        }
      });
    }
  } catch (error) {
    console.error("Error processing /identify request (outer catch):", error); // log the actual error
    if (!res.headersSent) { 
        res.status(500).json({error: "Internal server error during identity processing."});
    }
  } finally {
    client.release(); // always release client!!
  }
});

// global err handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Unhandled error caught by middleware:", err.message, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal Server Error" });
  } else {
    next(err); // default express error handler if headers already sent
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`POST requests to /identify will be handled.`);
});
