# Evaluation Plan: Field Study at a Real Conference

This plan describes how to test Consent Face Connect with real people at a real event, so the paper can report field results instead of lab-only results.

## 0. Phase 1: author self-test (before the event)

Use the Self-test tab of the live app (see README). One registered person (the author) runs genuine trials across nine conditions, impostor trials with faces of unregistered people, and no-face trials. Export the CSV and report: genuine match rate per condition, false matches, median genuine and impostor distances, and median time on the phone. This checks the threshold (0.5) before real attendees use the system.

## 1. Research questions

| ID | Question | Main measure |
|----|----------|--------------|
| RQ1 | Is face-based exchange faster and easier than the LinkedIn QR code? | Exchange time (seconds), System Usability Scale (SUS) |
| RQ2 | Do people feel in control of what is shared? | 5-point Likert items on control, comfort and trust |
| RQ3 | Does the agent apply each person's sharing rule the way they intended? | Agreement between the agent's tier and the tier the person says they wanted (asked in the exit survey for logged scans) |
| RQ4 | How reliable is recognition in real conditions? | Correct match rate, wrong match rate, "ambiguous" rate |
| RQ5 | Do the privacy guarantees hold in practice? | Count of stored non-enrolled templates (target: 0), deletion check at event end |

## 2. Where and who

- **Event:** one conference workshop, IEEE chapter meetup, or university research day with 60 to 150 attendees.
- **Participants:** about 34 volunteers. This is enough to detect a medium difference (Cohen's d = 0.5) between two methods in a paired comparison at α = 0.05 with 80% power.
- **Bystanders:** everyone else at the event. They are never enrolled and never matched. Signs at the entrance explain the study.

## 3. Design

Within-subject: each participant tries both methods.

- **Method A (baseline):** LinkedIn app QR code exchange.
- **Method B:** Consent Face Connect.
- **Order:** half the participants start with A, half with B (counterbalancing).
- **Task:** with each method, connect with 3 other participants you have not met.

## 4. Before the event (2 to 3 weeks)

1. Get ethics approval (university IRB or an equivalent ethics review) and written approval from the event organizer.
2. Complete a short Data Protection Impact Assessment (needed under GDPR Art. 35 for biometric data in the EU). If any participant is in Illinois, follow BIPA: written release (the enrollment consent screen) and a public retention and deletion schedule.
3. Deploy the server behind HTTPS (phone cameras only work on HTTPS). Set:
   - `EVENT_NAME`, `EVENT_ENDS_AT` (auto-delete time), `ADMIN_KEY`, `ANTHROPIC_API_KEY`.
4. Small pre-study changes:
   - Add a "Was this the right person?" Yes/No button after the profile is shown. This gives ground truth for RQ4.
   - Add the short in-app survey after each task.
5. Pilot with 5 colleagues. Check Wi-Fi, lighting at the venue, and phone models (iPhone and Android).

## 5. On the day

1. **Registration desk:** volunteers read the consent text, enroll with a selfie, and write their own sharing policy in plain English. A staff member is there to answer questions.
2. **Tasks:** participants do the two networking tasks during breaks.
3. **Stopwatch rule:** exchange time starts when the requester opens the method and ends when the LinkedIn profile opens.
4. **Exit survey (3 minutes):** SUS for each method, control and comfort items, preference, open comments.
5. **Event end:** the server deletes all face templates automatically at `EVENT_ENDS_AT`. A staff member also runs `POST /api/admin/close` and records the deletion count.

## 6. Data collected

| Data | Source | Contains personal data? |
|------|--------|--------------------------|
| Scan, match and decision log | `GET /api/admin/eval.csv` | No names, no faces, no profile fields |
| Exchange times | App log and stopwatch | No |
| Survey answers | Survey form | Pseudonymous participant code only |
| "Right person?" answers | App | No names |

Face templates are never exported. They exist only in server memory during the event.

## 7. Analysis

- **RQ1:** Wilcoxon signed-rank test on exchange time and SUS (A vs B). Report medians and effect size.
- **RQ2:** Report Likert distributions; Wilcoxon test where paired.
- **RQ3:** Percent agreement and Cohen's kappa between agent tier and final tier. List cases where the owner shared more or less than suggested.
- **RQ4:** Correct match rate and wrong match rate with 95% Wilson confidence intervals. Report the ambiguous rate separately.
- **RQ5:** Count of non-enrolled templates stored (expected 0 by design, verified in logs and code review). Confirm the deletion count equals the enrollment count.

## 8. Success criteria

- Median exchange time with Method B is equal to or lower than with the QR code.
- SUS score for Method B is 70 or higher.
- The agent's suggestion matches the owner's final choice in at least 70% of requests.
- Zero profiles released for a person who did not register. Any wrong match between registered people is visible in the scan log and can be blocked.
- All templates deleted at event end.

## 9. Threats to validity

- **Novelty effect:** people may like the new method just because it is new. Mitigation: ask about intent to use again.
- **Venue conditions:** low light and crowds affect detection. Record time of day and location.
- **Small sample:** results show feasibility, not population-level accuracy.
- **Fairness:** recognition accuracy can differ across groups. With a small sample, report this as a limitation and plan a larger fairness study.
