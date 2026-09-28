Set Shell bash
Set Width 1400
Set Height 875
Set FontSize 14
Set TypingSpeed 0.025

Sleep 0.4
Type "bash scripts/demo-env.sh"
Enter
Sleep 10

Type "/goal set Ship the widget demo --turns 6"
Enter
Sleep 2.5

Type "/goal task add Draft the VHS tape"
Enter
Sleep 1.4
Type "/goal task add Record the GIF"
Enter
Sleep 1.4
Type "/goal task add Embed in the README"
Enter
Sleep 1.4

Type "/goal task 1 done"
Enter
Sleep 1.8

Type "/goal view"
Enter
Sleep 3
Screenshot .demo/frame-view.png

Type "/goal task 2 done"
Enter
Sleep 1.6
Type "/goal task 3 doing"
Enter
Sleep 1.6

Type "/goal complete GIF recorded via scripts/demo.tape; output in .demo/goals-demo.gif, README embed pending"
Enter
Sleep 3.5
Screenshot .demo/frame-done.png

Type "/exit"
Enter
Sleep 2

Output .demo/goals-demo.gif
