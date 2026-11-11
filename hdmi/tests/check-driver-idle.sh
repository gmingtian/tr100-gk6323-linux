#!/bin/sh
# On-device regression check: all four background threads must reach TASK_IDLE.
set -eu
[ "$(uname -r)" = 5.10.165_gk6323-tr100-docker ]
ps -eLo pid=,state=,comm= | awk '
    $3 == "g_udisk_task" || $3 == "HDMI_kThread" ||
    $3 == "DispProcess" || $3 == "pthread_wbc_mem" {
        print
        seen[$3] = 1
        if ($2 != "I") bad = 1
    }
    END {
        for (name in seen) count++
        if (count != 4 || bad) {
            print "FAIL: expected four driver threads sleeping without load contribution"
            exit 1
        }
        print "PASS: all four driver threads use idle waits"
    }
'
