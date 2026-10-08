import os
import sqlite3

def solve():
    conn = sqlite3.connect(os.path.expanduser('~/.hermes/metrics/metrics.db'))
    cursor = conn.cursor()

    query = """
    SELECT session_id, ts, input_tokens, finish_reason 
    FROM records 
    WHERE kind='api' AND ts >= strftime('%s', 'now', '-48 hours')
    ORDER BY session_id, ts;
    """
    cursor.execute(query)
    rows = cursor.fetchall()

    sessions = {}
    for sid, ts, tokens, reason in rows:
        if sid not in sessions:
            sessions[sid] = []
        sessions[sid].append({'ts': ts, 'tokens': tokens, 'reason': reason})

    matches = 0
    true_positives = 0
    false_positives = 0

    print(f"Total sessions: {len(sessions)}")

    for sid, calls in sessions.items():
        sequences = []
        current_seq = []
        for call in calls:
            if call['reason'] == 'tool_calls':
                current_seq.append(call)
            else:
                if len(current_seq) >= 6:
                    sequences.append(list(current_seq))
                current_seq = []
        if len(current_seq) >= 6:
            sequences.append(list(current_seq))

        if not sequences:
            continue

        session_has_match = False
        for seq in sequences:
            steps = []
            for i in range(1, len(seq)):
                steps.append(seq[i]['ts'] - seq[i-1]['ts'])
            
            if not steps: continue
            
            median_step = sorted(steps)[len(steps)//2]
            if median_step == 0: median_step = 1

            is_loop = True
            for s in steps:
                if s > 4000 or not (0.55 * median_step <= s <= 1.45 * median_step):
                    is_loop = False
                    break
            
            if is_loop:
                session_has_match = True
                cursor.execute("SELECT count(*) FROM records WHERE session_id=? AND kind='error'", (sid,))
                has_errors = cursor.fetchone()[0] > 0

                if has_errors: 
                    tp = 1; fp = 0
                elif seq[-1]['reason'] == 'stop':
                    tp = 0; fp = 1
                else:
                    tp = 1; fp = 0
                
                true_positives += tp
                false_positives += fp
                break 

        if session_has_match:
            matches += 1

    print(f"Matches: {matches}")
    print(f"True Positives: {true_positives}")
    print(f"False Positives: {false_positives}")

if __name__ == "__main__":
    solve()
