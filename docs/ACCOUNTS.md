# Accounts, sign-in and one-time codes

These steps are for the server version (`npm start`). The hosted preview page has no server, so none of this applies there.

## 1. Sign in as admin
1. Copy `.env.example` to a file named exactly `.env` (Windows: make sure it is not `.env.txt`).
2. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in it. Password rules: 8+ characters, letters and a number, not a common password, and it must **not contain the first part of your email** (for `admin@example.com`, a password containing "admin" is rejected).
3. Run `npm start`. Read the lines starting with `>` in the terminal. They say if the admin was created, ignored or rejected, and why.
4. Open `http://127.0.0.1:3000/#login-admin` and sign in.

## 2. It says "Email or password is incorrect"
The admin is only created on the first start, and only if the password passes the rules. The usual causes:
* The password was rejected (the terminal says so). Often it contains "admin", is too common, or has no number.
* An admin from an older version already exists in the `data` folder, so `.env` is ignored. The terminal prints that admin's email.
* You edited `.env` but did not restart, or the file is called `.env.txt`.
* Five wrong tries lock the sign-in for 15 minutes (the message then says "Too many failed attempts").

**Fix for all of these:** in the project folder run

    npm run admin

It asks for an email and a new password (or use `npm run admin -- --email you@example.com --password "Your-Passw0rd"`). It creates the admin, or resets the password if that email is already an admin, and signs out its old sessions. No restart is needed. If you lost your authenticator app, add `--disable-2fa`.

## 3. Create a quality inspector (and where the one-time code comes from)
Inspectors cannot register themselves. The admin creates them:
1. Sign in as admin and open **Users**.
2. In **Add a quality inspector**, type their name and email, then press **Create and get setup code**.
3. A box shows a **one-time setup code**. Copy it now: it is shown once, works once, and expires in 24 hours. There is no email, so you send it to them yourself.
4. The inspector opens `http://127.0.0.1:3000/#login-inspector`, clicks **Have a setup or reset code?**, pastes the code, chooses a password and presses **Set password**.
5. They now sign in on the same page with their email and that password, and fill in their profile (qualification) once.
6. Quality queue, Safety guide and the other inspector tabs are then available.

## 4. Reset code for anyone who is locked out or forgot a password
Admin, **Users**, press **Reset password** next to the person. A one-time code (30 minutes) appears. They use **Have a setup or reset code?** on their portal's sign-in page.

## 5. Verification
NGOs, organisers and distributors can browse straight away but can only order or deliver after the admin or an inspector presses **Verify** next to their name in **Users** (they must have completed their profile first).

## 6. Two-factor sign-in (optional)
Profile, Security, **Set up two-factor authentication**. Add the key to an authenticator app, enter the 6-digit code, and keep the 8 recovery codes safe.
