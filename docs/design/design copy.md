Analyze this system design and provide a technical breakdown including the architecture, main components, and data flow. 



I want to develop an openclaw plugin, which can activate a head agent, a scheduler agent and a task status recorder agent at first in the openclaw instance environment. The head observes the external MCP service of grafana, and collect the runtime metrics data of LLM , it analyzes the data to get all the events need to be handled and can be handled, it decides to handle the events by planning tasks and pass the tasks to the task status recorder agent. The task status recorder agent init the status of each task. The scheduler agent keeps fetching the task from the task status recorder agent, and updates the task status to the task status recorder agent. The scheduler agent creates the worker agent to run the task, and updates the task status. The worker agent runs the task by calling the external MCP sevices and updates the task status.

The agents activating order of the first time.
1 start the task status recorder agent, keep checking the agent status, if it goes to the Listening status in 1 minute, it is started.
2 start the scheduler 


The running process of head agent
The head agent keeps observing the grafana service which has the runtime metrics data of the specified groups of LLM instance, and it will collect or get a data snapshot of last 5 mins, every 5 mins. It also analyze the data snapshot to detect or find any special events that need to be handled, like the metric of TFOT or TTFT increases to 200% quantity than 5 mins before in average, and the trend is still up. And like the metric of TFOT or TTFT decreases to 50% quantity than 5 mins before in average, and the trend is still down. Then the head agent make decision to handle the event, If the decision is to plan the tasks, the head will send the tasks to the task status record agent. It is required to check with the task status record agent whether it has enough space for the planning tasks, if not, make the decision to skip the handling.

The head agent needs to save the combination of the runtime metrics data snapshot, the corresponding events and tasks locally with a banding relationship. it keeps "n" copies, 5 by default. Once the new runtime metrics data snapshot comes, it replaces the oldest combination.

The starting process of head agent
Once the head agent starts, it set its status as Starting, then it starts to verify whether there is any copy of the runtime metrics data snapshot is not analyzed or decided, which means no corresponding events and tasks found at the head agent local. If there is, and it is not expired, say it doesn't exceed 1 minute (the default value) from the snapshot's created time, it is not expired, the head agent needs to analyze and decide the snapshot again. Then the head agent starts to observe the grafana and sets its status to Listening.

The stopping process of head agent



The running process of the task status recorder agent
Once the task status recorder agent receives the tasks from the head agent, it devides the tasks into peices and mark the task status as ready, which means ready-to-run, the create time, and the status modified time, then save them all at local.

The starting process of the task status recorder agent
Once the task status recorder agent starts, it checks all the tasks which status are ready, and the task is expired, the task created time + 1 minute (by default) is less than the current time, and update these tasks status to expired.

The stopping process of the task status recorder agent




The scheduler agent maintances a local task queue, the queue size is 10 by default. The scheduler keeps talking to the task status recorder agent and estimates which tasks need to be scheduled by checking the LLM deployment name of the task (the consideration of Horizontal Scaling in future, we may assign the specific openclaw instance to handle the specific groups of LLMs), the task status, severity, the status modified time and created time, then the scheduler picks the tasks up and copies them to the local queue.
If a task's status is ready and its create time is 1 minute before, which means it is expired, it is not need to be scheduled any more, the scheduler should update the task status to expired. If a task's status is scheduling and its status modified time is 30 seconds before, which means it is scheduling-timeout, it is not need to be scheduled any more, the scheduler should update the task status to expired.


Once it holds the task, it calls to the task status recorder agent to update the task status to scheduling, which means the task is scheduling to run, it also update the status modified time of the task. 

Then it creates a worker agent and give the task to the worker agent, after that, it update the status to scheduled, and the status modified time of the task.

The scheduler agent need to consider some cases like, the task is in scheduling-timeout and running-timeout status. it requires to decide whether to give up scheduling and running. if not giving up, it

the current and the status modified time, for example, if a task is scheduling, and its status modified time 

The created work agent 



 the scheduler agent create one worker agent per each task. And the worker agent will run the task until the task is done. The worker agent also needs to init and update the task status by calling to the task status recorder agent.