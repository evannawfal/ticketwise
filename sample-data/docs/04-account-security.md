---
title: Account security and two-factor authentication
url: https://help.northpine.example/security
---
# Account security

## Turn on two-factor authentication (2FA)

Go to Profile > Security > Two-factor authentication and scan the QR code with an authenticator app such as 1Password, Authy, or Google Authenticator. Save your 10 backup codes somewhere safe. Each backup code works once.

Workspace Owners on Team and Business plans can require 2FA for everyone under Settings > Security > Require 2FA. Members without 2FA are asked to set it up the next time they sign in.

## Lost your 2FA device

If you lost your phone, sign in with one of your backup codes, then set up 2FA again on your new device.

If you don't have backup codes:

1. A workspace Owner can reset your 2FA from Settings > Members > (your name) > Reset 2FA. This is the fastest option.
2. If you are the only Owner, contact support from your account email address. For security, support verifies identity by asking for the last 4 digits of the card on file and the date of the most recent invoice. Support never asks for your password.

After a reset, you are signed out everywhere and must set up 2FA again on your next sign-in.

## Single sign-on (SSO)

Business plans support SAML SSO with Okta, Microsoft Entra ID, and Google Workspace. Set it up under Settings > Security > SSO. Once SSO is enforced, members sign in through your identity provider and Northpine passwords are disabled. Owners can still sign in with a password as a break-glass option.

## Sessions

See and sign out of active sessions under Profile > Security > Sessions. Changing your password signs you out of all other sessions.
