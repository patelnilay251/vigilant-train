import * as THREE from 'three';

// Character controller and animation state machine.
//
// Movement is camera-relative with separated-axis resolution against deep water,
// so sliding along a shoreline works instead of sticking. The animation layer
// picks a clip from ground speed and drives its timeScale from the same number,
// which is what keeps the feet from skating.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

const WALK_SPEED = 2.6;
const RUN_SPEED = 5.8;
const ACCELERATION = 26;
const GROUND_DRAG = 12;
const AIR_DRAG = 1.4;
const GRAVITY = -23;
const JUMP_VELOCITY = 7.4;
const TURN_RATE = 13;
// Half-width of the character, used against scenery colliders.
const BODY_RADIUS = 0.24;

// Platformer feel, in seconds.
//
// Coyote time forgives a jump pressed just after walking off an edge; the
// buffer forgives one pressed just before landing. Both are invisible when
// they work and immediately felt when they are missing.
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.16;
// Releasing the button mid-rise cuts the climb, giving a jump whose height the
// player actually controls rather than one fixed arc.
const JUMP_CUT = 0.45;

export class Player {
  constructor(gltf, field) {
    this.field = field;

    this.root = new THREE.Group();
    this.root.name = 'player';

    this.model = gltf.scene;
    this.model.traverse((node) => {
      if (node.isMesh || node.isSkinnedMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        // Skinned bounds are computed from the bind pose and cull incorrectly
        // once the rig moves the silhouette outside it.
        node.frustumCulled = false;
      }
    });
    this.root.add(this.model);

    this.position = this.root.position;
    this.velocity = new THREE.Vector3();
    // The rig starts behind the character at yaw = PI, so facing +Z points the
    // model away from the camera.
    this.facing = 0;
    this.grounded = true;
    this.speed = 0;
    this.wading = false;

    const spawn = field.clampToWorld(0, 0);
    this.position.set(spawn[0], field.heightAt(spawn[0], spawn[1]), spawn[1]);

    // ---- animation
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      if (clip.name === 'jump' || clip.name === 'cheer') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions[clip.name] = action;
    }
    this.current = null;
    this.play('idle', 0);

    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._normal = { x: 0, y: 1, z: 0 };

    this.onFootstep = null;
    /** Set by the caller; scenery to be pushed out of. @type {?import('./colliders.js').ColliderField} */
    this.colliders = null;
    this._footPhase = 0;
    this._coyote = 0;
    this._buffer = 0;
    this._cheerTimer = 0;
    // Turned off when inspecting the model, so it stands upright regardless of
    // the ground it happens to be on.
    this.leanEnabled = true;
  }

  play(name, fade = 0.18) {
    const next = this.actions[name];
    if (!next || this.current === next) return;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    if (this.current) {
      next.crossFadeFrom(this.current, fade, false);
    }
    next.play();
    this.current = next;
    this.currentName = name;
  }

  /** True where the character is not allowed to stand. */
  blocked(x, z) {
    const [cx, cz] = this.field.clampToWorld(x, z, 3);
    if (cx !== x || cz !== z) return true;
    return this.field.heightAt(x, z) < this.field.waterLevel - 1.15;
  }

  update(dt, input, cameraRig) {
    // ---- desired direction, in the camera's horizontal frame
    cameraRig.basis(this._forward, this._right);
    this._move.set(0, 0, 0);
    this._move.addScaledVector(this._forward, input.axis.forward);
    this._move.addScaledVector(this._right, input.axis.right);

    const hasInput = this._move.lengthSq() > 1e-6;
    if (hasInput) this._move.normalize();

    const slope = this.field.slopeAt(this.position.x, this.position.z);
    const slopePenalty = 1 - clamp((slope - 0.35) / 0.9, 0, 0.55);
    const wadePenalty = this.wading ? 0.55 : 1;
    const targetSpeed = (input.sprint ? RUN_SPEED : WALK_SPEED) * slopePenalty * wadePenalty;

    // ---- horizontal velocity
    const drag = this.grounded ? GROUND_DRAG : AIR_DRAG;
    if (hasInput) {
      const accel = ACCELERATION * (this.grounded ? 1 : 0.35);
      this.velocity.x += this._move.x * accel * dt;
      this.velocity.z += this._move.z * accel * dt;

      const planar = Math.hypot(this.velocity.x, this.velocity.z);
      if (planar > targetSpeed) {
        const scale = targetSpeed / planar;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    } else if (this.grounded) {
      const decay = Math.exp(-drag * dt);
      this.velocity.x *= decay;
      this.velocity.z *= decay;
      if (Math.hypot(this.velocity.x, this.velocity.z) < 0.02) {
        this.velocity.x = 0;
        this.velocity.z = 0;
      }
    }

    // ---- jump and gravity
    this._coyote = this.grounded ? COYOTE_TIME : Math.max(0, this._coyote - dt);
    this._buffer = input.consumeJump() ? JUMP_BUFFER : Math.max(0, this._buffer - dt);

    if (this._buffer > 0 && this._coyote > 0) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
      this._coyote = 0;
      this._buffer = 0;
      this.play('jump', 0.08);
      if (this.onJump) this.onJump(this.position);
    }

    // Cut the rise when the button is released, before gravity is applied so
    // the same frame does not both cut and accelerate.
    if (!input.jumpHeld && this.velocity.y > 0) {
      this.velocity.y += GRAVITY * dt * (1 / JUMP_CUT - 1);
    }
    this.velocity.y += GRAVITY * dt;

    // ---- integrate horizontally, one axis at a time so walls allow sliding
    const nextX = this.position.x + this.velocity.x * dt;
    const nextZ = this.position.z + this.velocity.z * dt;

    if (!this.blocked(nextX, this.position.z)) {
      this.position.x = nextX;
    } else {
      this.velocity.x = 0;
    }
    if (!this.blocked(this.position.x, nextZ)) {
      this.position.z = nextZ;
    } else {
      this.velocity.z = 0;
    }

    // ---- push out of scenery
    //
    // Done after the axis-separated slide against water and the world edge, so
    // a prop standing in shallow water cannot shove the character into a place
    // the water test already rejected.
    if (this.colliders) {
      const pushed = this.colliders.resolve(this.position.x, this.position.z, BODY_RADIUS);
      if (pushed.hit && !this.blocked(pushed.x, pushed.z)) {
        this.position.x = pushed.x;
        this.position.z = pushed.z;
        // Cancel only the component of velocity heading into the obstacle;
        // whatever runs along it survives, so the character slides around a
        // trunk instead of sticking to it.
        const into = this.velocity.x * pushed.nx + this.velocity.z * pushed.nz;
        if (into < 0) {
          this.velocity.x -= pushed.nx * into;
          this.velocity.z -= pushed.nz * into;
        }
      }
    }

    // ---- vertical
    this.position.y += this.velocity.y * dt;
    const ground = this.field.heightAt(this.position.x, this.position.z);
    if (this.position.y <= ground) {
      const wasAirborne = !this.grounded;
      this.position.y = ground;
      this.velocity.y = 0;
      this.grounded = true;
      if (wasAirborne && this.onLand) this.onLand(this.position);
    } else if (this.position.y > ground + 0.06) {
      this.grounded = false;
    }

    this.wading = ground < this.field.waterLevel + 0.25;
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);

    // ---- face the direction of travel
    if (this.speed > 0.25) {
      const desired = Math.atan2(this.velocity.x, this.velocity.z);
      let delta = desired - this.facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.facing += delta * (1 - Math.exp(-TURN_RATE * dt));
    }
    this.root.rotation.y = this.facing;

    // ---- lean into slopes so the model does not float on hillsides
    this.field.normalAt(this.position.x, this.position.z, this._normal);
    const targetPitch = this.leanEnabled ? -this._normal.z * 0.45 : 0;
    const targetRoll = this.leanEnabled ? this._normal.x * 0.45 : 0;
    this.model.rotation.x += (targetPitch - this.model.rotation.x) * (1 - Math.exp(-6 * dt));
    this.model.rotation.z += (targetRoll - this.model.rotation.z) * (1 - Math.exp(-6 * dt));

    this._updateAnimation(dt);
    this.mixer.update(dt);
  }

  /** Plays the pickup celebration, which briefly overrides locomotion. */
  cheer() {
    this._cheerTimer = 0.62;
    this.play('cheer', 0.06);
  }

  _updateAnimation(dt) {
    if (this._cheerTimer > 0) {
      this._cheerTimer -= dt;
      // Cut the celebration short if the player is already running again.
      if (this.speed < WALK_SPEED * 1.2) return;
      this._cheerTimer = 0;
    }

    if (!this.grounded) {
      this.play('jump', 0.12);
      return;
    }

    if (this.speed < 0.22) {
      this.play('idle');
      this._footPhase = 0;
      return;
    }

    if (this.speed < WALK_SPEED * 1.25) {
      this.play('walk');
      // 2.5 m/s is the speed the clip was authored for.
      this.actions.walk.timeScale = clamp(this.speed / WALK_SPEED, 0.55, 1.7);
    } else {
      this.play('run');
      this.actions.run.timeScale = clamp(this.speed / RUN_SPEED, 0.6, 1.5);
    }

    // Emit a footstep twice per stride.
    const stride = this.currentName === 'run' ? 3.1 : 2.0;
    this._footPhase += this.speed * dt * stride * 0.5;
    if (this._footPhase >= 1) {
      this._footPhase -= 1;
      if (this.onFootstep) this.onFootstep(this.position, this.speed);
    }
  }
}
