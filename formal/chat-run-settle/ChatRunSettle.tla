---------------------------- MODULE ChatRunSettle ----------------------------
EXTENDS Naturals, Sequences

CONSTANTS DbYields, StallGuard, GuardAfterInsert, GuardOnCompleted,
          GuardAfterAttempt, GuardInCatch, SettleFinishes,
          FinishOnlyFromStreaming, MeterOnce, MeterOnFinish,
          MeterOnSettledCompletion, MeterAfterAttempt, ClaimOnPersist,
          CancelYieldsToClaim

VARIABLES pc, outcome, settled, queueClosed, runIdSet, row, msg, persisted,
          billed, metered, settledMetered, cancelPending, seen, finishing

vars == <<pc, outcome, settled, queueClosed, runIdSet, row, msg, persisted,
          billed, metered, settledMetered, cancelPending, seen, finishing>>

Outcomes == {"answer", "fail", "hang"}
NetWaits == {"start", "model"}
DbWaits == {"storeUser", "insertRun", "finishAfterInsert", "persistEv",
            "persistFinal", "finishCompleted", "tail", "catchFinish"}
Labels == NetWaits \cup DbWaits \cup {"afterAttempt", "catch", "done"}
RowStates == {"none", "streaming", "completed", "failed"}
Frames == {"failed", "end", "ok"}

Applies == row # "none" /\ (row = "streaming" \/ ~FinishOnlyFromStreaming)
FinishTo(s) == IF Applies THEN s ELSE row
Send(f) == IF queueClosed THEN seen ELSE Append(seen, f)
MeterOk(b) == (~MeterOnce \/ ~settledMetered) /\ runIdSet /\ b
Claim == finishing' = (finishing \/ ClaimOnPersist)

TypeOK ==
    /\ pc \in Labels
    /\ outcome \in Outcomes
    /\ row \in RowStates
    /\ metered \in 0..3
    /\ settled \in BOOLEAN
    /\ queueClosed \in BOOLEAN
    /\ runIdSet \in BOOLEAN
    /\ msg \in BOOLEAN
    /\ persisted \in BOOLEAN
    /\ billed \in BOOLEAN
    /\ settledMetered \in BOOLEAN
    /\ cancelPending \in BOOLEAN
    /\ seen \in Seq(Frames)
    /\ finishing \in BOOLEAN

Init ==
    /\ pc = "start"
    /\ outcome \in Outcomes
    /\ settled = FALSE
    /\ queueClosed = FALSE
    /\ runIdSet = FALSE
    /\ row = "none"
    /\ msg = FALSE
    /\ persisted = FALSE
    /\ billed = FALSE
    /\ metered = 0
    /\ settledMetered = FALSE
    /\ cancelPending = FALSE
    /\ seen = <<>>
    /\ finishing = FALSE

Settle ==
    /\ ~settled
    /\ pc # "done"
    /\ (pc \in NetWaits \/ (DbYields /\ pc \in DbWaits))
    /\ ~(CancelYieldsToClaim /\ finishing)
    /\ settled' = TRUE
    /\ queueClosed' = TRUE
    /\ seen' = IF queueClosed THEN seen ELSE seen \o <<"failed", "end">>
    /\ IF runIdSet /\ SettleFinishes /\ DbYields
         THEN /\ cancelPending' = TRUE
              /\ UNCHANGED row
         ELSE /\ row' = IF runIdSet /\ SettleFinishes THEN FinishTo("failed") ELSE row
              /\ UNCHANGED cancelPending
    /\ UNCHANGED <<pc, outcome, runIdSet, msg, persisted, billed, metered, settledMetered,
                   finishing>>

CancelFinish ==
    /\ cancelPending
    /\ cancelPending' = FALSE
    /\ row' = FinishTo("failed")
    /\ UNCHANGED <<pc, outcome, settled, queueClosed, runIdSet, msg, persisted,
                   billed, metered, settledMetered, seen, finishing>>

Start ==
    /\ pc = "start"
    /\ pc' = "storeUser"
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, row, msg, persisted,
                   billed, metered, settledMetered, cancelPending, seen, finishing>>

StoreUser ==
    /\ pc = "storeUser"
    /\ pc' = "insertRun"
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, row, msg, persisted,
                   billed, metered, settledMetered, cancelPending, seen, finishing>>

InsertRun ==
    /\ pc = "insertRun"
    /\ row' = "streaming"
    /\ runIdSet' = TRUE
    /\ pc' = IF settled /\ GuardAfterInsert THEN "finishAfterInsert" ELSE "model"
    /\ UNCHANGED <<outcome, settled, queueClosed, msg, persisted, billed, metered,
                   settledMetered, cancelPending, seen, finishing>>

FinishAfterInsert ==
    /\ pc = "finishAfterInsert"
    /\ row' = FinishTo("failed")
    /\ pc' = "done"
    /\ queueClosed' = TRUE
    /\ UNCHANGED <<outcome, settled, runIdSet, msg, persisted, billed, metered,
                   settledMetered, cancelPending, seen, finishing>>

ModelAnswers ==
    /\ pc = "model"
    /\ outcome = "answer"
    /\ billed' = TRUE
    /\ IF settled /\ GuardOnCompleted
         THEN /\ metered' = IF MeterOnSettledCompletion /\ MeterOk(TRUE) THEN metered + 1 ELSE metered
              /\ settledMetered' = (settledMetered \/ (MeterOnSettledCompletion /\ MeterOk(TRUE)))
              /\ pc' = "afterAttempt"
              /\ UNCHANGED finishing
         ELSE /\ pc' = "persistEv"
              /\ Claim
              /\ UNCHANGED <<metered, settledMetered>>
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, row, msg, persisted,
                   cancelPending, seen>>

ModelFails ==
    /\ pc = "model"
    /\ outcome = "fail"
    /\ seen' = Send("failed")
    /\ pc' = "catch"
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, row, msg, persisted,
                   billed, metered, settledMetered, cancelPending, finishing>>

ModelAborted ==
    /\ pc = "model"
    /\ settled
    /\ pc' = "catch"
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, row, msg, persisted,
                   billed, metered, settledMetered, cancelPending, seen, finishing>>

PersistEv ==
    /\ pc = "persistEv"
    /\ msg' = TRUE
    /\ persisted' = TRUE
    /\ seen' = Send("ok")
    /\ pc' = "afterAttempt"
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, row, billed, metered,
                   settledMetered, cancelPending, finishing>>

AfterAttempt ==
    /\ pc = "afterAttempt"
    /\ IF settled /\ GuardAfterAttempt
         THEN /\ metered' = IF MeterAfterAttempt /\ MeterOk(billed) THEN metered + 1 ELSE metered
              /\ settledMetered' = (settledMetered \/ (MeterAfterAttempt /\ MeterOk(billed)))
              /\ pc' = "done"
              /\ queueClosed' = TRUE
              /\ UNCHANGED finishing
         ELSE /\ pc' = "persistFinal"
              /\ Claim
              /\ UNCHANGED <<metered, settledMetered, queueClosed>>
    /\ UNCHANGED <<outcome, settled, runIdSet, row, msg, persisted, billed,
                   cancelPending, seen>>

PersistFinal ==
    /\ pc = "persistFinal"
    /\ msg' = TRUE
    /\ persisted' = TRUE
    /\ pc' = "finishCompleted"
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, row, billed, metered,
                   settledMetered, cancelPending, seen, finishing>>

FinishCompleted ==
    /\ pc = "finishCompleted"
    /\ row' = FinishTo("completed")
    /\ metered' = IF MeterOnFinish /\ Applies /\ billed THEN metered + 1 ELSE metered
    /\ pc' = "tail"
    /\ UNCHANGED <<outcome, settled, queueClosed, runIdSet, msg, persisted, billed,
                   settledMetered, cancelPending, seen, finishing>>

AfterFinish ==
    /\ pc = "tail"
    /\ pc' = "done"
    /\ queueClosed' = TRUE
    /\ UNCHANGED <<outcome, settled, runIdSet, row, msg, persisted, billed, metered,
                   settledMetered, cancelPending, seen, finishing>>

Catch ==
    /\ pc = "catch"
    /\ IF settled /\ GuardInCatch
         THEN /\ metered' = IF MeterOk(billed) THEN metered + 1 ELSE metered
              /\ settledMetered' = (settledMetered \/ MeterOk(billed))
              /\ pc' = "done"
              /\ queueClosed' = TRUE
              /\ UNCHANGED finishing
         ELSE /\ pc' = "catchFinish"
              /\ Claim
              /\ UNCHANGED <<metered, settledMetered, queueClosed>>
    /\ UNCHANGED <<outcome, settled, runIdSet, row, msg, persisted, billed,
                   cancelPending, seen>>

CatchFinish ==
    /\ pc = "catchFinish"
    /\ LET saved == (outcome = "answer" \/ persisted)
           status == IF saved THEN "completed" ELSE "failed"
       IN /\ msg' = (msg \/ saved)
          /\ persisted' = (persisted \/ saved)
          /\ row' = FinishTo(status)
          /\ metered' = IF Applies /\ billed THEN metered + 1 ELSE metered
          /\ seen' = IF queueClosed THEN seen
                     ELSE IF saved \/ outcome = "fail" THEN Append(seen, "end")
                     ELSE seen \o <<"failed", "end">>
    /\ pc' = "done"
    /\ queueClosed' = TRUE
    /\ UNCHANGED <<outcome, settled, runIdSet, billed, settledMetered, cancelPending,
                   finishing>>

Work ==
    \/ Start \/ StoreUser \/ InsertRun \/ FinishAfterInsert
    \/ ModelAnswers \/ ModelFails \/ ModelAborted \/ PersistEv
    \/ AfterAttempt \/ PersistFinal \/ FinishCompleted \/ AfterFinish
    \/ Catch \/ CatchFinish

Next == Work \/ Settle \/ CancelFinish

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(Work)
    /\ WF_vars(CancelFinish)
    /\ IF StallGuard THEN WF_vars(Settle) ELSE TRUE

FailedRowHasNoAnswer == row = "failed" => ~msg

AtMostOneUsageRow == metered <= 1

NoFailureAfterSuccess ==
    \A i \in 1..Len(seen) :
        seen[i] = "ok" => \A j \in (i + 1)..Len(seen) : seen[j] # "failed"

Quiet == pc = "done" /\ ~cancelPending

EndsSettled == Quiet => (runIdSet => row \in {"completed", "failed"})

BilledIsMetered == Quiet => (billed => metered = 1)

Termination == <>(pc = "done")
=============================================================================
