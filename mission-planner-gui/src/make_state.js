import RosLib from 'roslib';
import { GoalStatus } from './goal_status';

function make_gps_coordinate_state(ros, params) {
    let [lat, lon] = params.split(' ');
    lat = parseFloat(lat);
    lon = parseFloat(lon);
    return new NavigateToGpsState({
        ros, lat, lon
    });
}

function make_relative_coord_state(ros, params) {
    let position = new RosLib.Vector3();
    const orientation = new RosLib.Quaternion({x: 0, y: 0, z: 0, w: 1.0});
    const [x, y] = params.split(' ');
    position.x = parseFloat(x);
    position.y = parseFloat(y);
    const pose = new RosLib.Pose({
        position,
        orientation,
    });
    const goalMessage = {
        target_pose: {
            header: {
                frame_id: 'base_link',
            },
            pose: pose,
        },
    };
    const description = `Move to relative coordinate (${x}, ${y})`;

    return new ActionState({
        ros: ros,
        actionServerName: 'move_base',
        actionName: 'move_base_msgs/MoveBaseAction',
        actionResultMessageType: 'move_base_msgs/MoveBaseActionResult',
        goalMessage: goalMessage,
        description: description,
    });
}

function make_manual_control_state(ros, params) {
    return new TakeManualControlState();
}

export function make_state(ros, action_class, params) {
    const function_map = {
        'MoveToRelativeCoord': make_relative_coord_state,
        'MoveToGpsCoord': make_gps_coordinate_state,
        'TakeManualControl': make_manual_control_state,
    }
    if (action_class in function_map) {
        return function_map[action_class](ros, params);
    } else {
        console.warn(`Unrecognized action class "${action_class}". Making a dummy state instead.`);
        return new DummyState(action_class, params);
    }
}

class AbstractState {
    constructor() {
        if (new.target === AbstractState) {
            throw new TypeError('Please do not construct AbstractState directly.');
        }
    }
    setNextStateCallback(callback) {
        throw new TypeError('nextStateCallback() was not defined and so was called for AbstractState.');
    }
    enter() {
        throw new TypeError('enter() was not defined and so was called for AbstractState.');
    }
    cancel() {
        throw new TypeError('cancel() was not defined and so was called for AbstractState.');
    }
    getDescription() {
        throw new TypeError('getDescription() was not defined and so was called for AbstractState.');
    }
}

class DummyState extends AbstractState {
    constructor(action_class, params) {
        super();
        this.nextStateCallback = null;
        this.timeout = null;
        this.description = `${action_class} ${params}`;
    }

    setNextStateCallback(callback) {
        this.nextStateCallback = callback;
    }

    enter() {
        this.timeout = window.setTimeout(() => this.nextStateCallback(GoalStatus.Succeeded), 1000);
    }

    cancel() {
        window.clearTimeout(this.timeout);
        window.setTimeout(() => this.nextStateCallback(GoalStatus.Preempted) , 0);
    }

    getDescription() {
        return `Dummy state: ${this.description}`;
    }
}


class ActionState extends AbstractState {
    constructor({ros, actionServerName, actionName, actionResultMessageType, goalMessage, description}) {
        super();
        this.ros = ros;
        this.actionServerName = actionServerName;
        this.actionName = actionName;
        this.actionResultMessageType = actionResultMessageType;
        this.goalMessage = goalMessage;
        this.description = description;

        this.actionClient = new RosLib.ActionClient({
            ros: this.ros,
            serverName: this.actionServerName,
            actionName: this.actionName,
        });
        this.resultListener = new RosLib.Topic({
            ros: this.ros,
            name: `${this.actionServerName}/result`,
            messageType: this.actionResultMessageType,
        });
        this.nextStateCallback = null;
        this.goal = null;
    }

    setNextStateCallback(callback) {
        this.nextStateCallback = callback;
        this.resultListener.subscribe(message => {
            if (this.goal === null) {
                return;
            }
            if (message.status.goal_id.id !== this.goal.goalID) {
                return;
            }
            this.nextStateCallback(message.status.status);
            this.goal = null;
        });
    }

    enter() {
        console.log(`Entering state (${this.getDescription()})`);
        this.goal = new RosLib.Goal({
            actionClient: this.actionClient,
            goalMessage: this.goalMessage,
        });
        this.goal.on('timeout', (event) => {
            this.nextStateCallback(GoalStatus.Aborted);
        });
        this.goal.send();
    }

    cancel() {
        console.log(`Cancelling state (${this.getDescription()})`);
        this.actionClient.cancel();
    }

    getDescription() {
        return this.description;
    }
}

class TakeManualControlState extends AbstractState {
    setNextStateCallback(callback) {
        this.nextStateCallback = callback;
    }

    enter() {
        this.nextStateCallback(GoalStatus.Aborted);
    }

    cancel() {
        this.nextStateCallback(GoalStatus.Preempted);
    }

    getDescription() {
        return 'Take manual control';
    }
}

class NavigateToGpsState extends AbstractState {
    constructor({ros, lat, lon}) {
        super();
        this.ros = ros;
        this.lat = lat;
        this.lon = lon;
        
        this.actionClient = new RosLib.ActionClient({
            ros: this.ros,
            serverName: 'move_base',
            actionName: 'move_base_msgs/MoveBaseAction',
        });
        this.resultListener = new RosLib.Topic({
            ros: this.ros,
            name: 'move_base/result',
            messageType: 'move_base_msgs/MoveBaseActionResult',
        });
        this.nextStateCallback = null;
        this.goal = null;

        this.gpsToUtmClient = new RosLib.Service({
            ros: ros,
            name: 'gps_to_utm',
            serviceType: 'spear_rover/GpsToUtm',
        });
    }

    setNextStateCallback(callback) {
        this.nextStateCallback = callback;
        this.resultListener.subscribe(message => {
            if (this.goal === null) {
                return;
            }
            if (message.status.goal_id.id !== this.goal.goalID) {
                return;
            }
            this.nextStateCallback(message.status.status);
            this.goal = null;
        });
    }

    enter() {
        console.log(`Entering state (${this.getDescription()})`);

        console.log(`Translating (${this.lat}, ${this.lon}) from gps to utm coords...`);
        const request = new RosLib.ServiceRequest({
            gps_coord: {x: this.lat, y: this.lon, z: 0},
        });
        this.gpsToUtmClient.callService(request, result => {
            console.log(`Finished: (${result.utm_coord.x}, ${result.utm_coord.y})`)
            let position = new RosLib.Vector3();
            const orientation = new RosLib.Quaternion({x: 0, y: 0, z: 0, w: 1.0});
            position.x = result.utm_coord.x;
            position.y = result.utm_coord.y;

            this.goal = new RosLib.Goal({
                actionClient: this.actionClient,
                goalMessage: {
                    target_pose: {
                        header: {frame_id: 'utm'},
                        pose: new RosLib.Pose({position, orientation}),
                    },
                },
            });
            this.goal.on('timeout', (event) => {
                this.nextStateCallback(GoalStatus.Aborted);
            });
            this.goal.send();
        });
    }

    cancel() {
        console.log(`Cancelling state (${this.getDescription()})`);
        this.actionClient.cancel();
    }

    getDescription() {
        return `Move to gps coordinate (${this.lat}, ${this.lon})`;
    }
}